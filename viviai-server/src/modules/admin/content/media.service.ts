import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService } from '../../../shared/database/database.service.js';
import { AppError } from '../../../shared/http/errors.js';
import { ASSET_STORE } from '../../assets/assets.service.js';
import { validateImage } from '../../assets/image-validation.js';
import type { ObjectStore } from '../../assets/object-store.js';
import type { AdminContext } from '../auth.service.js';
import { requirePermission } from '../permissions.js';
import { failure } from '../team/policy.js';
import { canTransitionContent, type ContentLifecycle } from './content.service.js';
import { AdminContentCommands, lockContentResources } from './command.service.js';

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
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw failure(400, 'ADMIN_INVALID_INPUT', 'Invalid administrator request');
  return result.data;
}

@Injectable()
export class AdminContentMediaService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(ASSET_STORE) private readonly store: ObjectStore,
    @Inject(AdminContentCommands) private readonly commands: AdminContentCommands,
  ) {}

  async list(context: AdminContext, raw: unknown) {
    requirePermission(context.actor, 'content.media.read');
    const query = parse(listSchema, raw);
    const rows = await this.db.client.contentMedia.findMany({
      where: query.status ? { status: query.status } : {},
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: query.limit,
    });
    return { rows: rows.map((row) => this.dto(row)) };
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
    const extension = filename.split('.').pop()?.toLowerCase();
    if (
      !/^[a-z0-9][a-z0-9._-]{0,119}$/.test(filename) ||
      !extension ||
      !allowedExtensions.has(extension) ||
      !allowedMimeTypes.has(mimeType)
    )
      throw new AppError(400, 'INVALID_IMAGE', 'Invalid media filename or MIME type');
    const image = await validateImage(bytes);
    const id = randomUUID();
    const hash = createHash('sha256').update(image.bytes).digest('hex');
    const objectKey = `content/admin/${id}-${hash}.png`;
    let stored = false;
    try {
      return await this.commands.run(
        context,
        key,
        'content.media.create',
        `sha256:${hash}`,
        { reason, filename, mimeType, sha256: hash, byteSize: image.bytes.byteLength },
        ['content.media.read', 'content.media.write'],
        async (tx, current) => {
          await this.store.put(objectKey, image.bytes, image.contentType);
          stored = true;
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
      if (stored) await this.store.delete(objectKey).catch(() => undefined);
      throw error;
    }
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
      throw failure(422, 'CONTENT_NOT_PUBLISHABLE', '无法发布：media');
    }
    if (
      !allowedMimeTypes.has(row.contentType) ||
      bytes.byteLength !== row.byteSize ||
      createHash('sha256').update(bytes).digest('hex') !== row.sha256
    )
      throw failure(422, 'CONTENT_NOT_PUBLISHABLE', '无法发布：media');
  }
}
