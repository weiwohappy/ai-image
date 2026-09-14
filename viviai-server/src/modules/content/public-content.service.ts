import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { AppConfig } from '../../config.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { DatabaseService, type DbTransaction } from '../../shared/database/database.service.js';
import { AppError } from '../../shared/http/errors.js';
import { APP_CONFIG } from '../../shared/infrastructure.module.js';
import { ASSET_STORE } from '../assets/assets.service.js';
import type { ObjectStore } from '../assets/object-store.js';
import {
  presentInspiration,
  presentRemixTemplate,
  presentToolDefinition,
} from './content-presenter.js';

type CatalogKind = 'inspirations' | 'remix-templates' | 'tools';
type PageInput = { limit: number; cursor?: string };
type InspirationFilters = { category?: string; query?: string };
type RemixFilters = {
  category?: string;
  platform?: string;
  industry?: string;
  style?: string;
  query?: string;
};
type ToolFilters = { category?: string };

const cursorSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(['inspirations', 'remix-templates', 'tools']),
    externalId: z.string().regex(/^[a-z][a-z0-9-]{1,159}$/),
    sortOrder: z.number().int().min(0),
    filter: z.string().max(1024),
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const inspirationInclude = (userId?: string) =>
  ({
    coverMedia: { select: { externalId: true } },
    likes: userId ? { where: { userId }, select: { userId: true }, take: 1 } : false,
    _count: { select: { likes: true } },
  }) satisfies Prisma.InspirationInclude;

const templateInclude = (userId?: string) =>
  ({
    coverMedia: { select: { externalId: true } },
    favorites: userId ? { where: { userId }, select: { userId: true }, take: 1 } : false,
  }) satisfies Prisma.RemixTemplateInclude;

const toolInclude = {
  coverMedia: { select: { externalId: true } },
} satisfies Prisma.ToolDefinitionInclude;

@Injectable()
export class PublicContentService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(ASSET_STORE) private readonly store: ObjectStore,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async listInspirations(input: PageInput & InspirationFilters, userId?: string) {
    const filter = filterDigest({ category: input.category, query: input.query });
    const after = input.cursor
      ? await this.inspirationAnchor(
          decodeCursor(input.cursor, 'inspirations', filter, this.config.contentCursorSecret),
        )
      : undefined;
    const rows = await this.db.client.inspiration.findMany({
      where: {
        status: 'published',
        ...(input.category ? { category: input.category } : {}),
        ...(input.query ? { AND: searchClauses(input.query) } : {}),
        ...(after ? afterWhere(after) : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      take: input.limit + 1,
      include: inspirationInclude(userId),
    });
    return page(
      rows,
      input.limit,
      'inspirations',
      filter,
      this.config.contentCursorSecret,
      presentInspiration,
    );
  }

  async listRemixTemplates(input: PageInput & RemixFilters, userId?: string) {
    const filter = filterDigest({
      category: input.category,
      platform: input.platform,
      industry: input.industry,
      style: input.style,
      query: input.query,
    });
    const after = input.cursor
      ? await this.templateAnchor(
          decodeCursor(input.cursor, 'remix-templates', filter, this.config.contentCursorSecret),
        )
      : undefined;
    const rows = await this.db.client.remixTemplate.findMany({
      where: {
        status: 'published',
        ...(input.category ? { category: input.category } : {}),
        ...(input.platform ? { platform: input.platform } : {}),
        ...(input.industry ? { industry: input.industry } : {}),
        ...(input.style ? { style: input.style } : {}),
        ...(input.query ? { AND: searchClauses(input.query) } : {}),
        ...(after ? afterWhere(after) : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      take: input.limit + 1,
      include: templateInclude(userId),
    });
    return page(
      rows,
      input.limit,
      'remix-templates',
      filter,
      this.config.contentCursorSecret,
      presentRemixTemplate,
    );
  }

  async remixTemplate(externalId: string, userId?: string) {
    const row = await this.db.client.remixTemplate.findFirst({
      where: { externalId, status: 'published' },
      include: templateInclude(userId),
    });
    if (!row) throw missingContent();
    return presentRemixTemplate(row);
  }

  async listTools(input: PageInput & ToolFilters) {
    const filter = filterDigest({ category: input.category });
    const after = input.cursor
      ? await this.toolAnchor(
          decodeCursor(input.cursor, 'tools', filter, this.config.contentCursorSecret),
        )
      : undefined;
    const rows = await this.db.client.toolDefinition.findMany({
      where: {
        status: 'published',
        ...(input.category ? { category: input.category } : {}),
        ...(after ? afterWhere(after) : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      take: input.limit + 1,
      include: toolInclude,
    });
    return page(
      rows,
      input.limit,
      'tools',
      filter,
      this.config.contentCursorSecret,
      presentToolDefinition,
    );
  }

  async tool(externalId: string) {
    const row = await this.db.client.toolDefinition.findFirst({
      where: { externalId, status: 'published' },
      include: toolInclude,
    });
    if (!row) throw missingContent();
    return presentToolDefinition(row);
  }

  likeInspiration(userId: string, externalId: string) {
    return this.changeLike(userId, externalId, true);
  }

  unlikeInspiration(userId: string, externalId: string) {
    return this.changeLike(userId, externalId, false);
  }

  favoriteTemplate(userId: string, externalId: string) {
    return this.changeFavorite(userId, externalId, true);
  }

  unfavoriteTemplate(userId: string, externalId: string) {
    return this.changeFavorite(userId, externalId, false);
  }

  async media(externalId: string) {
    const media = await this.db.client.contentMedia.findFirst({
      where: {
        externalId,
        status: 'published',
        OR: [
          { inspirationCovers: { some: { status: 'published' } } },
          { inspirationCaseImages: { some: { status: 'published' } } },
          { remixTemplateCovers: { some: { status: 'published' } } },
          { remixTemplateReferences: { some: { status: 'published' } } },
          { toolCovers: { some: { status: 'published' } } },
          { toolIcons: { some: { status: 'published' } } },
        ],
      },
      select: {
        objectKey: true,
        sha256: true,
        contentType: true,
        byteSize: true,
      },
    });
    if (!media || !['image/png', 'image/jpeg', 'image/webp'].includes(media.contentType))
      throw missingContent();
    let bytes: Uint8Array;
    try {
      bytes = await this.store.get(media.objectKey);
    } catch (error) {
      if (isMissingObject(error)) throw missingContent();
      throw error;
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (bytes.byteLength !== media.byteSize || sha256 !== media.sha256)
      throw new AppError(500, 'CONTENT_MEDIA_CORRUPT', 'Published content is unavailable');
    return {
      bytes,
      contentType: media.contentType,
      byteSize: media.byteSize,
      etag: `"${media.sha256}"`,
    };
  }

  private async changeLike(userId: string, externalId: string, liked: boolean) {
    return this.db.transaction(async (tx) => {
      const inspirationId = await findPublished(tx, 'inspirations', externalId);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`content:inspiration-interaction:${inspirationId}`}, 0))`;
      if (liked)
        await tx.inspirationLike.upsert({
          where: { userId_inspirationId: { userId, inspirationId } },
          create: { userId, inspirationId },
          update: {},
        });
      else await tx.inspirationLike.deleteMany({ where: { userId, inspirationId } });
      const row = await tx.inspiration.findUniqueOrThrow({
        where: { id: inspirationId },
        include: inspirationInclude(userId),
      });
      return presentInspiration(row);
    });
  }

  private async changeFavorite(userId: string, externalId: string, favorite: boolean) {
    return this.db.transaction(async (tx) => {
      const remixTemplateId = await findPublished(tx, 'remix_templates', externalId);
      if (favorite)
        await tx.remixTemplateFavorite.upsert({
          where: { userId_remixTemplateId: { userId, remixTemplateId } },
          create: { userId, remixTemplateId },
          update: {},
        });
      else await tx.remixTemplateFavorite.deleteMany({ where: { userId, remixTemplateId } });
      const row = await tx.remixTemplate.findUniqueOrThrow({
        where: { id: remixTemplateId },
        include: templateInclude(userId),
      });
      return presentRemixTemplate(row);
    });
  }

  private async inspirationAnchor(cursor: Cursor) {
    const row = await this.db.client.inspiration.findUnique({
      where: { externalId: cursor.externalId },
      select: { id: true, sortOrder: true },
    });
    return validAnchor(row, cursor);
  }

  private async templateAnchor(cursor: Cursor) {
    const row = await this.db.client.remixTemplate.findUnique({
      where: { externalId: cursor.externalId },
      select: { id: true, sortOrder: true },
    });
    return validAnchor(row, cursor);
  }

  private async toolAnchor(cursor: Cursor) {
    const row = await this.db.client.toolDefinition.findUnique({
      where: { externalId: cursor.externalId },
      select: { id: true, sortOrder: true },
    });
    return validAnchor(row, cursor);
  }
}

type Cursor = z.infer<typeof cursorSchema>;
type CursorRow = { id: string; externalId: string; sortOrder: number };

function missingContent() {
  return new AppError(404, 'CONTENT_NOT_FOUND_OR_OFFLINE', 'Content is unavailable');
}

function invalidCursor(): never {
  throw new AppError(400, 'INVALID_CURSOR', 'Pagination cursor is invalid');
}

function filterDigest(filter: Record<string, string | undefined>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(filter).filter(([, value]) => value)));
}

function cursorMac(cursor: Omit<Cursor, 'checksum'>, secret: string): string {
  return createHmac('sha256', secret)
    .update(`content-cursor-v1:${JSON.stringify(cursor)}`)
    .digest('hex');
}

function encodeCursor(kind: CatalogKind, row: CursorRow, filter: string, secret: string): string {
  const payload = {
    version: 1 as const,
    kind,
    externalId: row.externalId,
    sortOrder: row.sortOrder,
    filter,
  };
  return Buffer.from(JSON.stringify({ ...payload, checksum: cursorMac(payload, secret) })).toString(
    'base64url',
  );
}

function decodeCursor(value: string, kind: CatalogKind, filter: string, secret: string): Cursor {
  if (!/^[A-Za-z0-9_-]{1,2048}$/.test(value)) return invalidCursor();
  let decoded: unknown;
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) return invalidCursor();
    decoded = JSON.parse(bytes.toString('utf8'));
  } catch {
    return invalidCursor();
  }
  const parsed = cursorSchema.safeParse(decoded);
  if (!parsed.success) return invalidCursor();
  const { checksum: received, ...payload } = parsed.data;
  const expected = cursorMac(payload, secret);
  if (
    !timingSafeEqual(Buffer.from(received, 'hex'), Buffer.from(expected, 'hex')) ||
    payload.kind !== kind ||
    payload.filter !== filter
  )
    return invalidCursor();
  return parsed.data;
}

function validAnchor(row: { id: string; sortOrder: number } | null, cursor: Cursor) {
  if (!row || row.sortOrder !== cursor.sortOrder) return invalidCursor();
  return row;
}

function afterWhere(anchor: { id: string; sortOrder: number }) {
  return {
    OR: [
      { sortOrder: { gt: anchor.sortOrder } },
      { sortOrder: anchor.sortOrder, id: { gt: anchor.id } },
    ],
  };
}

// Search matches the copy an editor writes in the console — title, description and tags — since
// that is where category, platform and style words actually appear. Tags compare exactly: prefix
// matching on an array would let one broad term drag in unrelated categories. Returned as AND
// clauses so a caller can combine them with the keyset `OR` from afterWhere().
function searchClauses(query: string) {
  return [
    {
      OR: [
        { title: { contains: query, mode: 'insensitive' as const } },
        { description: { contains: query, mode: 'insensitive' as const } },
        { tags: { has: query } },
      ],
    },
  ];
}

function page<Row extends CursorRow, Output>(
  rows: Row[],
  limit: number,
  kind: CatalogKind,
  filter: string,
  secret: string,
  present: (row: Row) => Output,
) {
  const hasMore = rows.length > limit;
  const visible = hasMore ? rows.slice(0, limit) : rows;
  const last = visible.at(-1);
  return {
    items: visible.map(present),
    nextCursor: hasMore && last ? encodeCursor(kind, last, filter, secret) : null,
  };
}

async function findPublished(
  tx: DbTransaction,
  table: 'inspirations' | 'remix_templates',
  externalId: string,
): Promise<string> {
  const row =
    table === 'inspirations'
      ? await tx.inspiration.findFirst({
          where: { externalId, status: 'published' },
          select: { id: true },
        })
      : await tx.remixTemplate.findFirst({
          where: { externalId, status: 'published' },
          select: { id: true },
        });
  const id = row?.id;
  if (!id) throw missingContent();
  return id;
}

function isMissingObject(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if ('code' in error && ['ENOENT', 'NoSuchKey', 'NotFound'].includes(String(error.code)))
    return true;
  if (['NoSuchKey', 'NotFound'].includes(error.name)) return true;
  if ('statusCode' in error && Number(error.statusCode) === 404) return true;
  if (!('$metadata' in error) || typeof error.$metadata !== 'object' || !error.$metadata)
    return false;
  return Number((error.$metadata as { httpStatusCode?: unknown }).httpStatusCode) === 404;
}
