import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import type { AppConfig } from '../../../config.js';
import { DatabaseService } from '../../../shared/database/database.service.js';
import { APP_CONFIG } from '../../../shared/infrastructure.module.js';
import { AppError } from '../../../shared/http/errors.js';
import { ASSET_STORE } from '../../assets/assets.service.js';
import { validateImage } from '../../assets/image-validation.js';
import type { ObjectStore } from '../../assets/object-store.js';
import type { AdminContext } from '../auth.service.js';
import { requirePermission } from '../permissions.js';
import { failure } from '../team/policy.js';
import { canTransitionContent, type ContentLifecycle } from './content.service.js';
import { AdminContentCommands, contentCommandRequestDigest } from './command.service.js';
import { lockContentResources } from '../../content/content-locks.js';
import { adminAfter, adminFilter, adminNextCursor, decodeAdminCursor } from './pagination.js';

const allowedMimeTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
const allowedExtensions = new Set(['png', 'jpg', 'jpeg', 'webp']);
const reasonSchema = z.string().trim().min(5).max(500);
const commandSchema = z
  .object({
    version: z.number().int().min(1).max(2_147_483_647),
    reason: reasonSchema,
    status: z.enum(['published', 'offline', 'archived']),
  })
  .strict();
const archiveSchema = z
  .object({ version: z.number().int().min(1).max(2_147_483_647), reason: reasonSchema })
  .strict();
const listSchema = z
  .object({
    status: z.enum(['draft', 'published', 'offline', 'archived']).optional(),
    q: z.string().trim().min(1).max(160).optional(),
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

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw failure(400, 'ADMIN_INVALID_INPUT', 'Invalid administrator request');
  return result.data;
}

function mutationId(id: string): string {
  if (!z.uuid().safeParse(id).success)
    throw failure(400, 'ADMIN_INVALID_INPUT', 'Invalid administrator request');
  return id;
}

@Injectable()
export class AdminContentMediaService {
  private readonly logger = new Logger(AdminContentMediaService.name);

  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ASSET_STORE) private readonly store: ObjectStore,
    @Inject(AdminContentCommands) private readonly commands: AdminContentCommands,
  ) {}

  async list(context: AdminContext, raw: unknown) {
    requirePermission(context.actor, 'content.media.read');
    const query = parse(listSchema, raw);
    const filter = adminFilter({
      status: query.status,
      q: query.q,
      updatedFrom: query.updatedFrom,
      updatedTo: query.updatedTo,
    });
    const after = decodeAdminCursor(query.cursor, 'media', filter, this.config.contentCursorSecret);
    const rows = await this.db.client.contentMedia.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.q
          ? {
              OR: [
                { externalId: { contains: query.q, mode: 'insensitive' } },
                { sha256: { contains: query.q, mode: 'insensitive' } },
              ],
            }
          : {}),
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
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    return {
      rows: rows.slice(0, query.limit).map((row) => this.dto(row)),
      nextCursor: adminNextCursor(
        rows,
        query.limit,
        'media',
        filter,
        this.config.contentCursorSecret,
      ),
    };
  }

  async upload(
    context: AdminContext,
    key: string,
    bytes: Uint8Array,
    filename: string,
    mimeType: string,
    rawReason: unknown,
  ) {
    requirePermission(context.actor, 'content.media.read');
    requirePermission(context.actor, 'content.media.write');
    const reason = parse(reasonSchema, rawReason);
    if (!z.uuid().safeParse(key).success)
      throw failure(400, 'ADMIN_INVALID_INPUT', '需要有效幂等键');
    const extension = filename.split('.').pop()?.toLowerCase();
    if (
      !/^[a-z0-9][a-z0-9._-]{0,119}$/.test(filename) ||
      !extension ||
      !allowedExtensions.has(extension) ||
      !allowedMimeTypes.has(mimeType)
    )
      throw new AppError(400, 'INVALID_IMAGE', 'Invalid media filename or MIME type');
    const image = await validateImage(bytes);
    const id = deterministicMediaId(context.actor.id, key);
    const hash = createHash('sha256').update(image.bytes).digest('hex');
    const objectKey = `content/admin/${id}-${hash}.png`;
    const action = 'content.media.create';
    const target = `sha256:${hash}`;
    const commandInput = {
      reason,
      filename,
      mimeType,
      sha256: hash,
      byteSize: image.bytes.byteLength,
    };
    const requestDigest = contentCommandRequestDigest(action, target, commandInput);
    return this.db.withSessionAdvisoryLock(
      `content:media-upload:${context.actor.id}:${key}`,
      30_000,
      async () => {
        let putAttempted = false;
        let putConfirmed = false;
        try {
          return await this.commands.run(
            context,
            key,
            action,
            target,
            commandInput,
            ['content.media.read', 'content.media.write'],
            async (tx, current) => {
              putAttempted = true;
              await this.store.put(objectKey, image.bytes, image.contentType);
              putConfirmed = true;
              const row = await tx.contentMedia.create({
                data: {
                  id,
                  externalId: `content-media-${id}`,
                  objectKey,
                  sha256: hash,
                  contentType: image.contentType,
                  width: image.width,
                  height: image.height,
                  byteSize: image.bytes.byteLength,
                  createdByAdminId: current.actor.id,
                  updatedByAdminId: current.actor.id,
                },
              });
              return {
                result: { ...this.dto(row), filename },
                metadata: {
                  contentKind: 'media',
                  changedFields: ['create'],
                  afterStatus: 'draft',
                  afterVersion: 1,
                },
              };
            },
          );
        } catch (error) {
          if (!putAttempted) throw error;
          let receipt:
            | { action: string; target: string; requestDigest: string; result: unknown }
            | null
            | undefined;
          let row:
            | {
                id: string;
                externalId: string;
                objectKey: string;
                sha256: string;
                contentType: string;
                width: number;
                height: number;
                byteSize: number;
              }
            | null
            | undefined;
          try {
            [receipt, row] = await Promise.all([
              this.db.client.adminCommandReceipt.findUnique({
                where: {
                  accountId_idempotencyKey: { accountId: context.actor.id, idempotencyKey: key },
                },
                select: { action: true, target: true, requestDigest: true, result: true },
              }),
              this.db.client.contentMedia.findUnique({
                where: { id },
                select: {
                  id: true,
                  externalId: true,
                  objectKey: true,
                  sha256: true,
                  contentType: true,
                  width: true,
                  height: true,
                  byteSize: true,
                },
              }),
            ]);
          } catch {
            await this.recordUploadAlert(id, 'upload_outcome_unknown');
            throw new AppError(
              503,
              'CONTENT_MEDIA_UPLOAD_OUTCOME_UNKNOWN',
              '上传结果正在对账，请稍后查询',
              { details: { reason: 'outcome_unknown' } },
            );
          }
          const receiptMatches =
            receipt?.action === action &&
            receipt.target === target &&
            receipt.requestDigest === requestDigest;
          const rowMatches =
            row?.id === id &&
            row.externalId === `content-media-${id}` &&
            row.objectKey === objectKey &&
            row.sha256 === hash &&
            row.contentType === image.contentType &&
            row.width === image.width &&
            row.height === image.height &&
            row.byteSize === image.bytes.byteLength;
          if (receiptMatches && rowMatches) {
            if (!putConfirmed && !(await this.storedUploadMatches(objectKey, image))) {
              await this.recordUploadAlert(id, 'upload_outcome_unknown');
              throw uploadOutcomeUnknown();
            }
            return receipt!.result;
          }
          if (receipt || row) {
            await this.recordUploadAlert(id, 'upload_outcome_unknown');
            throw uploadOutcomeUnknown();
          }
          if (!putConfirmed && !(await this.storedUploadMatches(objectKey, image))) {
            await this.recordUploadAlert(id, 'upload_outcome_unknown');
            throw uploadOutcomeUnknown();
          }
          try {
            await this.store.delete(objectKey);
          } catch {
            await this.recordUploadAlert(id, 'rollback_cleanup_failed');
            throw new AppError(503, 'CONTENT_MEDIA_CLEANUP_PENDING', '上传回滚清理待处理', {
              details: { reason: 'cleanup_pending' },
            });
          }
          throw error;
        }
      },
    );
  }

  async metadata(context: AdminContext, id: string) {
    requirePermission(context.actor, 'content.media.read');
    return this.dto(await this.find(id));
  }

  async read(context: AdminContext, id: string) {
    requirePermission(context.actor, 'content.media.read');
    const row = await this.find(id);
    let bytes: Uint8Array;
    try {
      bytes = await this.store.get(row.objectKey);
    } catch {
      throw new AppError(404, 'CONTENT_MEDIA_NOT_FOUND', 'Content media not found');
    }
    if (
      !allowedMimeTypes.has(row.contentType) ||
      bytes.byteLength !== row.byteSize ||
      createHash('sha256').update(bytes).digest('hex') !== row.sha256
    )
      throw new AppError(404, 'CONTENT_MEDIA_NOT_FOUND', 'Content media not found');
    return { row, bytes };
  }

  async transition(context: AdminContext, key: string, id: string, raw: unknown) {
    mutationId(id);
    const input = parse(commandSchema, raw);
    return this.commands.run(
      context,
      key,
      `content.media.${input.status === 'published' ? 'publish' : input.status === 'offline' ? 'offline' : 'archive'}`,
      id,
      input,
      ['content.media.read', 'content.media.write'],
      async (tx, current) => {
        await lockContentResources(tx, [`media:${id}`]);
        const before = await tx.contentMedia.findUnique({ where: { id } });
        if (!before) throw failure(404, 'CONTENT_MEDIA_NOT_FOUND', '内容媒体不存在');
        if (before.version !== input.version || before.version >= 2_147_483_647)
          throw failure(409, 'CONTENT_VERSION_CONFLICT', '内容已更新，请重新加载后比较');
        if (!canTransitionContent(before.status as ContentLifecycle, input.status))
          throw failure(422, 'CONTENT_INVALID_TRANSITION', '无效内容状态转换');
        if (input.status === 'published') await this.verifyStored(before);
        if (before.status === 'published' && input.status !== 'published') {
          const references = await Promise.all([
            tx.inspiration.count({
              where: { status: 'published', OR: [{ coverMediaId: id }, { caseMediaId: id }] },
            }),
            tx.remixTemplate.count({
              where: { status: 'published', OR: [{ coverMediaId: id }, { referenceMediaId: id }] },
            }),
            tx.toolDefinition.count({
              where: { status: 'published', OR: [{ coverMediaId: id }, { iconMediaId: id }] },
            }),
          ]);
          if (references.some(Boolean))
            throw failure(422, 'CONTENT_MEDIA_IN_USE', '媒体仍被已发布内容使用');
        }
        const row = await tx.contentMedia.update({
          where: { id },
          data: {
            status: input.status,
            version: { increment: 1 },
            updatedByAdminId: current.actor.id,
            ...(input.status === 'published' && !before.publishedAt
              ? { publishedAt: new Date() }
              : {}),
          },
        });
        return {
          result: this.dto(row),
          metadata: {
            contentKind: 'media',
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

  async archive(context: AdminContext, key: string, id: string, raw: unknown) {
    mutationId(id);
    const input = parse(archiveSchema, raw);
    return this.transition(context, key, id, { ...input, status: 'archived' });
  }

  dto(row: {
    id: string;
    externalId: string;
    contentType: string;
    width: number;
    height: number;
    byteSize: number;
    sha256: string;
    status: string;
    version: number;
    publishedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      resourceId: row.id,
      id: row.id,
      externalId: row.externalId,
      contentType: row.contentType,
      width: row.width,
      height: row.height,
      byteSize: row.byteSize,
      sha256: row.sha256,
      status: row.status,
      version: row.version,
      publishedAt: row.publishedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      previewUrl: `/api/admin/content/media/${row.id}/content`,
    };
  }

  private async find(id: string) {
    if (!z.uuid().safeParse(id).success)
      throw new AppError(404, 'CONTENT_MEDIA_NOT_FOUND', 'Content media not found');
    const row = await this.db.client.contentMedia.findUnique({ where: { id } });
    if (!row) throw new AppError(404, 'CONTENT_MEDIA_NOT_FOUND', 'Content media not found');
    return row;
  }

  private async verifyStored(row: {
    objectKey: string;
    contentType: string;
    byteSize: number;
    sha256: string;
  }) {
    let bytes: Uint8Array;
    try {
      bytes = await this.store.get(row.objectKey);
    } catch {
      throw mediaPublishFailure();
    }
    if (
      !allowedMimeTypes.has(row.contentType) ||
      bytes.byteLength !== row.byteSize ||
      createHash('sha256').update(bytes).digest('hex') !== row.sha256
    )
      throw mediaPublishFailure();
  }

  private async recordUploadAlert(resourceId: string, kind: string): Promise<void> {
    const sourceKey = `content-media:${kind}:${resourceId}`;
    await this.db.client.adminAlert
      .upsert({
        where: { sourceKey },
        create: { sourceKey, category: 'content', kind, resourceId },
        update: { lastSeenAt: new Date(), resolved: false },
      })
      .catch(() =>
        this.logger.error(`content media alert persistence failed kind=${kind} id=${resourceId}`),
      );
  }

  private async storedUploadMatches(
    objectKey: string,
    expected: { bytes: Uint8Array; contentType: string; width: number; height: number },
  ): Promise<boolean> {
    try {
      const stored = await this.store.get(objectKey);
      if (
        stored.byteLength !== expected.bytes.byteLength ||
        createHash('sha256').update(stored).digest('hex') !==
          createHash('sha256').update(expected.bytes).digest('hex')
      )
        return false;
      const decoded = await validateImage(stored);
      return (
        decoded.contentType === expected.contentType &&
        decoded.width === expected.width &&
        decoded.height === expected.height
      );
    } catch {
      return false;
    }
  }
}

function deterministicMediaId(accountId: string, idempotencyKey: string): string {
  const bytes = createHash('sha256')
    .update(`admin-content-media-v1:${accountId}:${idempotencyKey}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function mediaPublishFailure(): AppError {
  return new AppError(422, 'CONTENT_NOT_PUBLISHABLE', '无法发布：media', {
    field: 'media',
    details: { reason: 'not_publishable' },
  });
}

function uploadOutcomeUnknown(): AppError {
  return new AppError(503, 'CONTENT_MEDIA_UPLOAD_OUTCOME_UNKNOWN', '上传结果正在对账，请稍后查询', {
    details: { reason: 'outcome_unknown' },
  });
}
