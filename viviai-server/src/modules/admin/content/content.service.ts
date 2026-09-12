import { isDeepStrictEqual } from 'node:util';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { AppConfig } from '../../../config.js';
import { DatabaseService, type DbTransaction } from '../../../shared/database/database.service.js';
import { APP_CONFIG } from '../../../shared/infrastructure.module.js';
import type { AdminContext } from '../auth.service.js';
import { requirePermission } from '../permissions.js';
import { failure } from '../team/policy.js';
import {
  inspirationInputSchema,
  lifecycleSchema,
  remixTemplateInputSchema,
  toolDefinitionInputSchema,
} from '../../content/content-contracts.js';
import { AdminContentCommands, type ContentCommandResult } from './command.service.js';
import { lockContentResources } from '../../content/content-locks.js';
import { AdminContentPublishValidator } from './publish-validator.js';
import { adminAfter, adminFilter, adminNextCursor, decodeAdminCursor } from './pagination.js';

const transitions = {
  draft: ['published', 'archived'],
  published: ['offline'],
  offline: ['published', 'archived'],
  archived: [],
} as const;

export type ContentLifecycle = keyof typeof transitions;
export type ContentKind = 'inspirations' | 'remix-templates' | 'tools';

export function canTransitionContent(from: ContentLifecycle, to: ContentLifecycle): boolean {
  return transitions[from].includes(to as never);
}

const reasonSchema = z.string().trim().min(5).max(500);
const versionSchema = z.number().int().min(1).max(2_147_483_647);
const listSchema = z
  .object({
    status: lifecycleSchema.optional(),
    q: z.string().trim().min(1).max(160).optional(),
    tag: z.string().trim().min(1).max(160).optional(),
    updatedFrom: z.iso.datetime().optional(),
    updatedTo: z.iso.datetime().optional(),
    cursor: z.string().min(1).max(2048).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(50),
  })
  .strict()
  .refine(
    (query) => !query.updatedFrom || !query.updatedTo || query.updatedFrom <= query.updatedTo,
    { path: ['updatedFrom'] },
  );
const transitionSchema = z
  .object({ version: versionSchema, reason: reasonSchema, status: lifecycleSchema })
  .strict();
const archiveSchema = z.object({ version: versionSchema, reason: reasonSchema }).strict();
const reorderSchema = z
  .object({
    reason: reasonSchema,
    items: z
      .array(
        z
          .object({
            id: z.uuid(),
            version: versionSchema,
            sortOrder: z.number().int().min(0).max(1_000_000),
          })
          .strict(),
      )
      .min(1)
      .max(100)
      .refine((items) => new Set(items.map((item) => item.id)).size === items.length),
  })
  .strict();

const inputSchemas = {
  inspirations: inspirationInputSchema,
  'remix-templates': remixTemplateInputSchema,
  tools: toolDefinitionInputSchema,
};

type RecordValue = Record<string, unknown>;

function record(input: unknown): RecordValue {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw failure(400, 'ADMIN_INVALID_INPUT', 'Invalid administrator request');
  return input as RecordValue;
}

function parsed<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw failure(400, 'ADMIN_INVALID_INPUT', 'Invalid administrator request');
  return result.data;
}

function mutationId(id: string): string {
  if (!z.uuid().safeParse(id).success)
    throw failure(400, 'ADMIN_INVALID_INPUT', 'Invalid administrator request');
  return id;
}

function permissionFamily(kind: ContentKind): 'inspirations' | 'templates' | 'tools' {
  return kind === 'remix-templates' ? 'templates' : kind;
}

@Injectable()
export class AdminContentService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AdminContentCommands) private readonly commands: AdminContentCommands,
    @Inject(AdminContentPublishValidator)
    private readonly publishValidator: AdminContentPublishValidator,
  ) {}

  async list(context: AdminContext, kind: ContentKind, raw: unknown) {
    requirePermission(context.actor, `content.${permissionFamily(kind)}.read`);
    const query = parsed(listSchema, raw);
    if (kind === 'tools' && query.tag)
      throw failure(400, 'ADMIN_INVALID_INPUT', 'Invalid administrator request');
    const filter = adminFilter({
      status: query.status,
      q: query.q,
      tag: query.tag,
      updatedFrom: query.updatedFrom,
      updatedTo: query.updatedTo,
    });
    const after = decodeAdminCursor(query.cursor, kind, filter, this.config.contentCursorSecret);
    const client = this.client(this.db.client, kind);
    const rows = await client.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.q
          ? {
              OR: [
                kind === 'tools'
                  ? { name: { contains: query.q, mode: 'insensitive' } }
                  : { title: { contains: query.q, mode: 'insensitive' } },
                { externalId: { contains: query.q, mode: 'insensitive' } },
              ],
            }
          : {}),
        ...(query.tag ? { tags: { has: query.tag } } : {}),
        ...(query.updatedFrom || query.updatedTo
          ? {
              updatedAt: {
                ...(query.updatedFrom ? { gte: new Date(query.updatedFrom) } : {}),
                ...(query.updatedTo ? { lte: new Date(query.updatedTo) } : {}),
              },
            }
          : {}),
        ...adminAfter(after),
      },
      include: this.mediaInclude(kind),
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    return {
      rows: rows.slice(0, query.limit).map((row: RecordValue) => this.dto(kind, row)),
      nextCursor: adminNextCursor(rows, query.limit, kind, filter, this.config.contentCursorSecret),
    };
  }

  async detail(context: AdminContext, kind: ContentKind, id: string) {
    requirePermission(context.actor, `content.${permissionFamily(kind)}.read`);
    if (!z.uuid().safeParse(id).success) throw failure(404, 'CONTENT_NOT_FOUND', '内容不存在');
    const row = await this.client(this.db.client, kind).findUnique({
      where: { id },
      include: this.mediaInclude(kind),
    });
    if (!row) throw failure(404, 'CONTENT_NOT_FOUND', '内容不存在');
    return this.dto(kind, row);
  }

  async create(context: AdminContext, key: string, kind: ContentKind, raw: unknown) {
    const body = record(raw);
    const { reason, ...candidate } = body;
    const commandReason = parsed(reasonSchema, reason);
    const input = parsed(inputSchemas[kind] as z.ZodType<RecordValue>, candidate);
    if (input.status !== 'draft')
      throw failure(422, 'CONTENT_INVALID_TRANSITION', '新内容必须保存为草稿');
    const family = permissionFamily(kind);
    return this.commands.run(
      context,
      key,
      `content.${family}.create`,
      String(input.externalId),
      { reason: commandReason, content: input },
      [`content.${family}.read`, `content.${family}.write`],
      async (tx, current) => {
        await lockContentResources(tx, [`${kind}:external:${String(input.externalId)}`]);
        const client = this.client(tx, kind);
        if (await client.findUnique({ where: { externalId: input.externalId } }))
          throw failure(409, 'CONTENT_ALREADY_EXISTS', '内容标识已存在');
        const data = await this.data(tx, kind, input, current.actor.id, true);
        const row = await client.create({ data, include: this.mediaInclude(kind) });
        return {
          result: this.dto(kind, row),
          metadata: {
            contentKind: this.auditKind(kind),
            changedFields: Object.keys(data).filter((field) => !field.endsWith('AdminId')),
            afterStatus: 'draft',
            afterVersion: 1,
          },
        };
      },
    );
  }

  async update(context: AdminContext, key: string, kind: ContentKind, id: string, raw: unknown) {
    mutationId(id);
    const body = record(raw);
    const { reason, version, ...candidate } = body;
    const commandReason = parsed(reasonSchema, reason);
    const expected = parsed(versionSchema, version);
    const input = parsed(inputSchemas[kind] as z.ZodType<RecordValue>, candidate);
    const family = permissionFamily(kind);
    return this.commands.run(
      context,
      key,
      `content.${family}.update`,
      id,
      { reason: commandReason, version: expected, content: input },
      [`content.${family}.read`, `content.${family}.write`],
      async (tx, current) => {
        const client = this.client(tx, kind);
        const observed = await client.findUnique({ where: { id } });
        if (!observed) throw failure(404, 'CONTENT_NOT_FOUND', '内容不存在');
        const mediaKeys = await this.mediaResourceKeys(tx, input);
        await lockContentResources(tx, [`${kind}:${id}`, ...mediaKeys]);
        const before = await client.findUnique({ where: { id } });
        if (!before) throw failure(404, 'CONTENT_NOT_FOUND', '内容不存在');
        if (before.status === 'published')
          requirePermission(current.actor, `content.${family}.publish`);
        this.expectedVersion(before.version, expected);
        if (before.externalId !== input.externalId)
          throw failure(422, 'CONTENT_IMMUTABLE_ID', '公开内容标识不可修改');
        if (before.status !== input.status)
          throw failure(422, 'CONTENT_INVALID_TRANSITION', '请使用状态转换命令');
        const data = await this.data(tx, kind, input, current.actor.id, false);
        const changedFields = Object.keys(data).filter(
          (field) => field !== 'updatedByAdminId' && !isDeepStrictEqual(before[field], data[field]),
        );
        if (!changedFields.length) {
          const unchanged = await client.findUnique({
            where: { id },
            include: this.mediaInclude(kind),
          });
          return {
            result: this.dto(kind, unchanged),
            metadata: {
              contentKind: this.auditKind(kind),
              changedFields: [],
              beforeStatus: before.status,
              afterStatus: before.status,
              beforeVersion: before.version,
              afterVersion: before.version,
            },
          };
        }
        if (before.status === 'published')
          await this.commands.enforcePublishRateLimit(tx, current, `content.${family}.update`);
        if (before.version >= 2_147_483_647)
          throw failure(409, 'CONTENT_VERSION_CONFLICT', '内容版本已达上限');
        const proposed = { ...before, ...data };
        if (before.status === 'published') await this.publishValidator.validate(tx, kind, proposed);
        const row = await client.update({
          where: { id },
          data: { ...data, version: { increment: 1 } },
          include: this.mediaInclude(kind),
        });
        return {
          result: this.dto(kind, row),
          metadata: {
            contentKind: this.auditKind(kind),
            changedFields,
            beforeStatus: before.status,
            afterStatus: row.status,
            beforeVersion: before.version,
            afterVersion: row.version,
          },
        };
      },
    );
  }

  async transition(
    context: AdminContext,
    key: string,
    kind: ContentKind,
    id: string,
    raw: unknown,
  ) {
    mutationId(id);
    const input = parsed(transitionSchema, raw);
    const family = permissionFamily(kind);
    return this.commands.run(
      context,
      key,
      `content.${family}.${input.status === 'published' ? 'publish' : input.status === 'offline' ? 'offline' : 'archive'}`,
      id,
      input,
      [`content.${family}.read`, `content.${family}.write`, `content.${family}.publish`],
      async (tx, current) => {
        const client = this.client(tx, kind);
        const observed = await client.findUnique({ where: { id } });
        if (!observed) throw failure(404, 'CONTENT_NOT_FOUND', '内容不存在');
        const mediaKeys = this.rowMediaIds(kind, observed).map((mediaId) => `media:${mediaId}`);
        await lockContentResources(tx, [`${kind}:${id}`, ...mediaKeys]);
        const before = await client.findUnique({ where: { id } });
        if (!before) throw failure(404, 'CONTENT_NOT_FOUND', '内容不存在');
        this.expectedVersion(before.version, input.version);
        if (!canTransitionContent(before.status, input.status))
          throw failure(422, 'CONTENT_INVALID_TRANSITION', '无效内容状态转换');
        if (before.version >= 2_147_483_647)
          throw failure(409, 'CONTENT_VERSION_CONFLICT', '内容版本已达上限');
        if (before.status === 'published' && input.status !== 'published')
          await this.commands.enforcePublishRateLimit(
            tx,
            current,
            `content.${family}.${input.status === 'offline' ? 'offline' : 'archive'}`,
          );
        if (input.status === 'published') await this.publishValidator.validate(tx, kind, before);
        const row = await client.update({
          where: { id },
          data: {
            status: input.status,
            version: { increment: 1 },
            updatedByAdminId: current.actor.id,
            ...(input.status === 'published' && !before.publishedAt
              ? { publishedAt: new Date() }
              : {}),
          },
          include: this.mediaInclude(kind),
        });
        return {
          result: this.dto(kind, row),
          metadata: {
            contentKind: this.auditKind(kind),
            changedFields: ['status'],
            beforeStatus: before.status,
            afterStatus: row.status,
            beforeVersion: before.version,
            afterVersion: row.version,
          },
        };
      },
    );
  }

  async archive(context: AdminContext, key: string, kind: ContentKind, id: string, raw: unknown) {
    mutationId(id);
    const input = parsed(archiveSchema, raw);
    return this.transition(context, key, kind, id, { ...input, status: 'archived' });
  }

  async reorder(context: AdminContext, key: string, kind: ContentKind, raw: unknown) {
    const input = parsed(reorderSchema, raw);
    const family = permissionFamily(kind);
    return this.commands.run(
      context,
      key,
      `content.${family}.reorder`,
      kind,
      input,
      [`content.${family}.read`, `content.${family}.write`],
      async (tx, current) => {
        await lockContentResources(
          tx,
          input.items.map((item) => `${kind}:${item.id}`),
        );
        const client = this.client(tx, kind);
        const rows = await client.findMany({
          where: { id: { in: input.items.map((item) => item.id) } },
        });
        if (rows.length !== input.items.length)
          throw failure(404, 'CONTENT_NOT_FOUND', '内容不存在');
        if (rows.some((row: RecordValue) => row.status === 'published'))
          requirePermission(current.actor, `content.${family}.publish`);
        const before = new Map<string, RecordValue>(
          rows.map((row: RecordValue) => [String(row.id), row]),
        );
        for (const item of input.items) {
          const row = before.get(item.id)!;
          this.expectedVersion(Number(row.version), item.version);
          if (Number(row.version) >= 2_147_483_647)
            throw failure(409, 'CONTENT_VERSION_CONFLICT', '内容版本已达上限');
        }
        if (
          input.items.some((item) => {
            const row = before.get(item.id)!;
            return row.status === 'published' && row.sortOrder !== item.sortOrder;
          })
        )
          await this.commands.enforcePublishRateLimit(tx, current, `content.${family}.reorder`);
        const results = [];
        for (const item of input.items) {
          const row = before.get(item.id)!;
          if (row.sortOrder === item.sortOrder) {
            results.push({ id: item.id, version: item.version, sortOrder: item.sortOrder });
            continue;
          }
          const updated = await client.update({
            where: { id: item.id },
            data: {
              sortOrder: item.sortOrder,
              version: { increment: 1 },
              updatedByAdminId: current.actor.id,
            },
          });
          results.push({ id: updated.id, version: updated.version, sortOrder: updated.sortOrder });
        }
        return {
          result: { resourceId: kind, items: results },
          metadata: {
            contentKind: this.auditKind(kind),
            changedFields: ['sortOrder'],
            itemCount: results.length,
          },
        };
      },
    );
  }

  private expectedVersion(actual: number, expected: number) {
    if (actual !== expected)
      throw failure(409, 'CONTENT_VERSION_CONFLICT', '内容已更新，请重新加载后比较');
  }

  private client(tx: any, kind: ContentKind): any {
    return kind === 'inspirations'
      ? tx.inspiration
      : kind === 'remix-templates'
        ? tx.remixTemplate
        : tx.toolDefinition;
  }

  private mediaInclude(kind: ContentKind): RecordValue {
    const relation = { select: { externalId: true } };
    return kind === 'inspirations'
      ? { coverMedia: relation, caseMedia: relation }
      : kind === 'remix-templates'
        ? { coverMedia: relation, referenceMedia: relation }
        : { coverMedia: relation, iconMedia: relation };
  }

  private dto(kind: ContentKind, raw: RecordValue): ContentCommandResult {
    const row = { ...raw };
    row.resourceId = row.id;
    const cover = row.coverMedia as { externalId: string } | null | undefined;
    delete row.coverMedia;
    delete row.coverMediaId;
    delete row.createdByAdminId;
    delete row.updatedByAdminId;
    row.coverMediaExternalId = cover?.externalId;
    if (kind === 'inspirations') {
      const media = row.caseMedia as { externalId: string } | null | undefined;
      delete row.caseMedia;
      delete row.caseMediaId;
      if (media) row.caseMediaExternalId = media.externalId;
    } else if (kind === 'remix-templates') {
      const media = row.referenceMedia as { externalId: string } | null | undefined;
      delete row.referenceMedia;
      delete row.referenceMediaId;
      if (media) row.referenceMediaExternalId = media.externalId;
    } else {
      const media = row.iconMedia as { externalId: string } | null | undefined;
      delete row.iconMedia;
      delete row.iconMediaId;
      row.fields = row.fieldSchema;
      delete row.fieldSchema;
      if (media) row.iconMediaExternalId = media.externalId;
    }
    return row as ContentCommandResult;
  }

  private auditKind(kind: ContentKind): 'inspiration' | 'remix_template' | 'tool' {
    return kind === 'inspirations'
      ? 'inspiration'
      : kind === 'remix-templates'
        ? 'remix_template'
        : 'tool';
  }

  private async data(
    tx: DbTransaction,
    kind: ContentKind,
    input: RecordValue,
    adminId: string,
    create: boolean,
  ): Promise<RecordValue> {
    const externalIds = [
      input.coverMediaExternalId,
      input.caseMediaExternalId,
      input.referenceMediaExternalId,
      input.iconMediaExternalId,
    ].filter((value): value is string => typeof value === 'string');
    const media = await tx.contentMedia.findMany({
      where: { externalId: { in: [...new Set(externalIds)] } },
    });
    const byExternalId = new Map(media.map((item) => [item.externalId, item.id]));
    const mediaId = (externalId: unknown) => {
      if (typeof externalId !== 'string') return null;
      const id = byExternalId.get(externalId);
      if (!id) throw failure(422, 'CONTENT_INVALID_MEDIA', '媒体引用不存在');
      return id;
    };
    const source = {
      creatorName: input.creatorName ?? null,
      sourceType: input.sourceType ?? null,
      sourceName: input.sourceName ?? null,
      sourceUrl: input.sourceUrl ?? null,
    };
    const provenance = {
      updatedByAdminId: adminId,
      ...(create ? { createdByAdminId: adminId } : {}),
    };
    if (kind === 'inspirations')
      return {
        externalId: input.externalId,
        title: input.title,
        description: input.description,
        category: input.category,
        ...source,
        editorialLabel: input.editorialLabel ?? null,
        baseLikes: input.baseLikes,
        tags: input.tags,
        defaultPrompt: input.defaultPrompt,
        defaultModelId: input.defaultModelId,
        defaultOutputSpecId: input.defaultOutputSpecId,
        coverMediaId: mediaId(input.coverMediaExternalId),
        caseMediaId: mediaId(input.caseMediaExternalId),
        status: input.status,
        sortOrder: input.sortOrder,
        ...provenance,
      };
    if (kind === 'remix-templates')
      return {
        externalId: input.externalId,
        title: input.title,
        description: input.description,
        category: input.category,
        ...source,
        platform: input.platform,
        industry: input.industry,
        style: input.style,
        popularityLabel: input.popularityLabel ?? null,
        baseRemixCount: input.baseRemixCount,
        tags: input.tags,
        visualAnalysis: input.visualAnalysis,
        defaultPrompt: input.defaultPrompt,
        defaultParameters: input.defaultParameters,
        defaultModelId: input.defaultModelId,
        defaultOutputSpecId: input.defaultOutputSpecId,
        coverMediaId: mediaId(input.coverMediaExternalId),
        referenceMediaId: mediaId(input.referenceMediaExternalId),
        status: input.status,
        sortOrder: input.sortOrder,
        ...provenance,
      };
    return {
      externalId: input.externalId,
      name: input.name,
      description: input.description,
      category: input.category,
      ...source,
      isNew: input.isNew,
      fieldSchema: input.fields,
      promptTemplate: input.promptTemplate,
      defaults: input.defaults,
      maxAssets: input.maxAssets,
      maxOutputCount: input.maxOutputCount,
      assetLabel: input.assetLabel,
      defaultModelId: input.defaultModelId,
      defaultOutputSpecId: input.defaultOutputSpecId,
      coverMediaId: mediaId(input.coverMediaExternalId),
      iconMediaId: mediaId(input.iconMediaExternalId),
      status: input.status,
      sortOrder: input.sortOrder,
      ...provenance,
    };
  }

  private rowMediaIds(kind: ContentKind, row: RecordValue): string[] {
    const fields =
      kind === 'inspirations'
        ? ['coverMediaId', 'caseMediaId']
        : kind === 'remix-templates'
          ? ['coverMediaId', 'referenceMediaId']
          : ['coverMediaId', 'iconMediaId'];
    return fields
      .map((field) => row[field])
      .filter((value): value is string => typeof value === 'string');
  }

  private async mediaResourceKeys(tx: DbTransaction, input: RecordValue): Promise<string[]> {
    const externalIds = [
      input.coverMediaExternalId,
      input.caseMediaExternalId,
      input.referenceMediaExternalId,
      input.iconMediaExternalId,
    ].filter((value): value is string => typeof value === 'string');
    const media = await tx.contentMedia.findMany({
      where: { externalId: { in: [...new Set(externalIds)] } },
      select: { id: true },
    });
    return media.map((row) => `media:${row.id}`);
  }
}
