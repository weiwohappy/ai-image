import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { loadConfig, type AppConfig } from '../config.js';
import { LocalObjectStore } from '../modules/assets/local-object-store.js';
import { S3ObjectStore } from '../modules/assets/s3-object-store.js';
import type { ObjectStore } from '../modules/assets/object-store.js';
import { validateImage } from '../modules/assets/image-validation.js';
import {
  contentSeedManifestSchema,
  type ContentSeedManifest,
} from '../modules/content/content-contracts.js';
import { CatalogService } from '../modules/catalog/catalog.service.js';
import { activeCreditPrice } from '../modules/catalog/credit-pricing.js';
import { getOfficialOutputSpec, OFFICIAL_MODELS } from '../modules/providers/official-models.js';
import { DatabaseService, type DbTransaction } from '../shared/database/database.service.js';

export type { ContentSeedManifest } from '../modules/content/content-contracts.js';

const visualSeeds = [
  ['NO. 01', '#f2a264', '#8f5ed8', '#3f284f'],
  ['NO. 02', '#446e60', '#84af87', '#1f3031'],
  ['NO. 03', '#ee7b6d', '#edbd68', '#5a392e'],
  ['NO. 04', '#5d6fc4', '#bd8cec', '#302852'],
  ['NO. 05', '#3a8f95', '#72d2bc', '#17434c'],
  ['NO. 06', '#c95c6a', '#f2a96b', '#5d2437'],
  ['NO. 07', '#7560bd', '#69a1cd', '#293257'],
  ['NO. 08', '#d69b43', '#f0d286', '#5f4b31'],
  ['NO. 09', '#a45164', '#d980a3', '#442337'],
  ['NO. 10', '#3c7c62', '#9cc078', '#243b2c'],
  ['NO. 11', '#b85b3b', '#f3a45c', '#542d27'],
  ['NO. 12', '#496db0', '#8ab3dd', '#22314e'],
] as const;

const inspirationTitles = [
  '透明香氛',
  '雨林精华',
  '秋日礼盒',
  '紫色胶片',
  '海盐气泡',
  '珊瑚时刻',
  '极光科技',
  '晨间咖啡',
  '花漾海报',
  '自然护肤',
  '暖调餐饮',
  '蓝调空间',
] as const;
const categories = ['电商视觉', '摄影写真', '平面设计', '插画漫画', '影视', '建筑家装'] as const;
const templateTitles = [
  '高透香氛主图',
  '雨林成分视觉',
  '秋日礼盒海报',
  '紫调人物封面',
  '清爽饮品主图',
  '美妆质感海报',
  '科技新品封面',
  '精品咖啡菜单',
  '花漾节日营销',
] as const;

// This is a reviewed, deterministic server-side extraction of the public mock catalogs.
// Do not import the frontend fixture: it uses aliases and is untrusted at server runtime.
export const contentSeedManifest: ContentSeedManifest = contentSeedManifestSchema.parse({
  media: visualSeeds.map(([seed, ...colors], index) => ({
    externalId: `content-media-visual-${index + 1}`,
    logicalFilename: `mock-visual-${index + 1}.png`,
    seed,
    colors,
    status: 'published',
  })),
  inspirations: inspirationTitles.map((title, index) => ({
    externalId: `inspiration-${index + 1}`,
    title,
    description: `商业视觉示例 ${index + 1}，主体清晰，光影有层次，保留文案安全区`,
    category: categories[index % categories.length]!,
    editorialLabel: index < 3 ? '编辑精选' : undefined,
    baseLikes: 286 + index * 137,
    creatorName: ['Luna Studio', 'North Lab', '见山设计', 'Kite Visual'][index % 4],
    sourceType: 'platform',
    sourceName: 'Viviai curated mock catalog',
    tags: [categories[index % categories.length]!],
    defaultPrompt: `商业视觉示例 ${index + 1}，主体清晰，光影有层次，保留文案安全区`,
    defaultModelId: 'gemini-3.1-flash-image',
    defaultOutputSpecId: 'png-1k-1x1-v1',
    coverMediaExternalId: `content-media-visual-${index + 1}`,
    status: 'published',
    sortOrder: index,
  })),
  templates: templateTitles.map((title, index) => ({
    externalId: `template-${index + 1}`,
    title,
    description: `${title}的可复用视觉模板`,
    category: ['电商主图', '商品海报', '小红书封面'][index % 3]!,
    platform: ['小红书', '淘宝', '抖音'][index % 3]!,
    industry: ['美妆', '食品', '消费电子'][index % 3]!,
    style: ['电影感', '自然系', '高级简约'][index % 3]!,
    popularityLabel: index < 3 ? '近期热门' : '编辑精选',
    baseRemixCount: 420 + index * 173,
    creatorName: ['Luna Studio', 'North Lab', '见山设计', 'Kite Visual'][index % 4],
    sourceType: 'platform',
    sourceName: 'Viviai curated mock catalog',
    tags: ['平台精选', index % 2 ? '含留白' : '高对比'],
    visualAnalysis: {
      composition:
        index % 2 ? '主体居中，环形动线，顶部留白' : '主体偏左，斜向动线，右侧文案安全区',
      palette: ['#d8ff52', '#8067e8', '#f29a63'],
      lighting: '右上方柔光，边缘高光，背景低对比渐变',
      camera: '平视中景，轻微长焦压缩空间',
      typographyZone: '右上区域，四周保留 8% 安全边距',
      avoid: ['原图 Logo', '原文案', '水印', '可识别人物身份'],
    },
    defaultPrompt: `${title}，保留主体并提供清晰文案安全区`,
    defaultParameters: { strength: 'balanced' },
    defaultModelId: 'gemini-3.1-flash-image',
    defaultOutputSpecId: index % 3 === 0 ? 'png-1k-3x4-v1' : 'png-1k-1x1-v1',
    coverMediaExternalId: `content-media-visual-${index + 1}`,
    referenceMediaExternalId: `content-media-visual-${index + 1}`,
    status: 'published',
    sortOrder: index,
  })),
  // Current mock tool IDs are preserved. They stay draft until a configured server model/spec
  // and an active ModelCreditPrice make them executable.
  tools: [
    {
      externalId: 'product-polish',
      name: '产品精修',
      description: '优化材质、光线与商品轮廓，保持产品结构',
      category: '电商工具',
      isNew: true,
      fields: [
        {
          id: 'product-type',
          label: '产品类型',
          type: 'select',
          required: true,
          options: ['护肤品', '服装', '食品', '消费电子'].map((value) => ({ label: value, value })),
        },
        { id: 'requirements', label: '额外要求', type: 'text', required: false },
      ],
      promptTemplate: '精修{{product-type}}产品图。额外要求：{{requirements}}。保持产品结构。',
      defaults: { modelId: 'gemini-3.1-flash-image', resolution: '1K', ratio: '1:1', count: 1 },
      maxAssets: 1,
      maxOutputCount: 1,
      assetLabel: '产品图',
      defaultModelId: 'gemini-3.1-flash-image',
      defaultOutputSpecId: 'png-1k-1x1-v1',
      coverMediaExternalId: 'content-media-visual-2',
      status: 'draft',
      sortOrder: 0,
    },
    {
      externalId: 'photo-restore',
      name: '一键老照片修复',
      description: '修复划痕与模糊细节，可选择彩色或黑白',
      category: '摄影写真',
      fields: [
        {
          id: 'style',
          label: '修复风格',
          type: 'radio',
          required: true,
          options: [
            { label: '彩色', value: 'color' },
            { label: '黑白', value: 'mono' },
          ],
        },
      ],
      promptTemplate: '修复老照片，使用{{style}}风格，保留人物和构图。',
      defaults: { modelId: 'gemini-3.1-flash-image', resolution: '1K', ratio: '1:1', count: 1 },
      maxAssets: 1,
      maxOutputCount: 1,
      assetLabel: '老照片',
      defaultModelId: 'gemini-3.1-flash-image',
      defaultOutputSpecId: 'png-1k-1x1-v1',
      coverMediaExternalId: 'content-media-visual-8',
      status: 'draft',
      sortOrder: 1,
    },
    {
      externalId: 'white-background',
      name: '电商白底图',
      description: '批量提取商品主体并生成规范白底图',
      category: '服装电商',
      fields: [
        {
          id: 'garment-type',
          label: '商品类型',
          type: 'select',
          required: true,
          options: ['自动', '上衣', '裤子', '裙子', '套装'].map((value) => ({
            label: value,
            value,
          })),
        },
      ],
      promptTemplate: '为{{garment-type}}生成规范电商白底图，提取商品主体。',
      defaults: { modelId: 'gemini-3.1-flash-image', resolution: '2K', ratio: '1:1', count: 1 },
      maxAssets: 3,
      maxOutputCount: 1,
      assetLabel: '产品图',
      defaultModelId: 'gemini-3.1-flash-image',
      defaultOutputSpecId: 'png-2k-1x1-v1',
      coverMediaExternalId: 'content-media-visual-5',
      status: 'draft',
      sortOrder: 2,
    },
  ],
});

export interface SeedContentOptions {
  manifest?: ContentSeedManifest;
  isModelSpecEnabled?: (modelId: string, outputSpecId: string) => boolean | Promise<boolean>;
  // Bounded to protect the command from waiting indefinitely for another seed session.
  lockTimeoutMs?: number;
  // Test-only lifecycle probes; they do not alter seeding behavior.
  lifecycle?: {
    beforeLockAttempt?: () => void | Promise<void>;
    afterLockAcquired?: () => void | Promise<void>;
    beforeCleanup?: (category: CleanupWarningCategory) => void | Promise<void>;
  };
  // Injectable only for owned test cleanup verification; production callers must not use it.
  beforeTransaction?: () => void | Promise<void>;
}

interface PreparedMedia {
  externalId: string;
  logicalFilename: string;
  objectKey: string;
  sha256: string;
  contentType: 'image/png';
  width: number;
  height: number;
  byteSize: number;
  status: 'draft' | 'published' | 'offline' | 'archived';
  bytes: Uint8Array;
}

export async function seedContent(
  db: DatabaseService,
  store: ObjectStore,
  options: SeedContentOptions = {},
): Promise<{
  media: number;
  inspirations: number;
  templates: number;
  tools: number;
  mediaCounts: { created: number; updated: number; unchanged: number };
  inspirationCounts: SeedOperationCounts;
  templateCounts: SeedOperationCounts;
  toolCounts: SeedOperationCounts;
  cleanupWarnings: CleanupWarningCounts;
}> {
  const parsed = contentSeedManifestSchema.safeParse(options.manifest ?? contentSeedManifest);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid content seed manifest: ${detail}`);
  }
  const manifest = parsed.data;
  const preparedMedia = await Promise.all(manifest.media.map(prepareMedia));
  const newlyWritten: string[] = [];
  const obsoleteObjectKeys: string[] = [];
  const mediaCounts = { created: 0, updated: 0, unchanged: 0 };
  const inspirationCounts: SeedOperationCounts = { created: 0, updated: 0, unchanged: 0 };
  const templateCounts: SeedOperationCounts = { created: 0, updated: 0, unchanged: 0 };
  const toolCounts: SeedOperationCounts = { created: 0, updated: 0, unchanged: 0 };
  const changedMediaExternalIds = new Set<string>();
  const cleanupWarnings: CleanupWarningCounts = { rollback: 0, obsolete: 0 };
  try {
    await db.withSessionAdvisoryLock(
      'content:seed',
      seedLockTimeoutMs(options.lockTimeoutMs),
      async () => {
        try {
          for (const media of preparedMedia) {
            const existing = await db.client.contentMedia.findUnique({
              where: { externalId: media.externalId },
            });
            const collision = await db.client.contentMedia.findUnique({
              where: { objectKey: media.objectKey },
            });
            if (collision && collision.externalId !== media.externalId)
              throw new Error(
                `Content media ${media.logicalFilename} (${media.externalId}) object key collision`,
              );
            if (existing && existing.objectKey !== media.objectKey) {
              obsoleteObjectKeys.push(existing.objectKey);
            }
            if (existing?.sha256 === media.sha256 && existing.objectKey === media.objectKey) {
              let stored: Uint8Array;
              try {
                stored = await store.get(media.objectKey);
              } catch (error) {
                throw namedMediaError(media, error);
              }
              if (sha256(stored) !== media.sha256)
                throw namedMediaError(
                  media,
                  new Error('stored bytes do not match the catalog digest'),
                );
              continue;
            }
            try {
              await store.put(media.objectKey, media.bytes, media.contentType);
              newlyWritten.push(media.objectKey);
            } catch (error) {
              throw namedMediaError(media, error);
            }
          }

          await db.transaction(async (tx) => {
            await options.beforeTransaction?.();
            const mediaIds = new Map<string, string>();
            for (const media of preparedMedia) {
              const current = await tx.contentMedia.findUnique({
                where: { externalId: media.externalId },
              });
              const data = {
                objectKey: media.objectKey,
                sha256: media.sha256,
                contentType: media.contentType,
                width: media.width,
                height: media.height,
                byteSize: media.byteSize,
                status: media.status,
              };
              const changed = !current || !sameMedia(current, data);
              const saved =
                current && !changed
                  ? (mediaCounts.unchanged++, current)
                  : current
                    ? await tx.contentMedia.update({
                        where: { id: current.id },
                        data: {
                          ...data,
                          version: { increment: 1 },
                          publishedAt:
                            media.status === 'published'
                              ? (current.publishedAt ?? new Date())
                              : null,
                        },
                      })
                    : await tx.contentMedia.create({
                        data: {
                          externalId: media.externalId,
                          ...data,
                          publishedAt: media.status === 'published' ? new Date() : null,
                        },
                      });
              if (current && changed) mediaCounts.updated++;
              if (!current) mediaCounts.created++;
              if (changed) changedMediaExternalIds.add(media.externalId);
              mediaIds.set(media.externalId, saved.id);
            }

            const changedMediaIds = [...changedMediaExternalIds].map((externalId) =>
              requiredMedia(mediaIds, externalId),
            );
            if (changedMediaIds.length) {
              const update = { version: { increment: 1 } };
              inspirationCounts.updated += (
                await tx.inspiration.updateMany({
                  where: {
                    externalId: { notIn: manifest.inspirations.map((row) => row.externalId) },
                    OR: [
                      { coverMediaId: { in: changedMediaIds } },
                      { caseMediaId: { in: changedMediaIds } },
                    ],
                  },
                  data: update,
                })
              ).count;
              templateCounts.updated += (
                await tx.remixTemplate.updateMany({
                  where: {
                    externalId: { notIn: manifest.templates.map((row) => row.externalId) },
                    OR: [
                      { coverMediaId: { in: changedMediaIds } },
                      { referenceMediaId: { in: changedMediaIds } },
                    ],
                  },
                  data: update,
                })
              ).count;
              toolCounts.updated += (
                await tx.toolDefinition.updateMany({
                  where: {
                    externalId: { notIn: manifest.tools.map((row) => row.externalId) },
                    OR: [
                      { coverMediaId: { in: changedMediaIds } },
                      { iconMediaId: { in: changedMediaIds } },
                    ],
                  },
                  data: update,
                })
              ).count;
            }

            for (const row of manifest.inspirations) {
              incrementSeedOperation(
                inspirationCounts,
                await upsertInspiration(
                  tx,
                  row,
                  mediaIds,
                  changedMediaExternalIds.has(row.coverMediaExternalId) ||
                    (row.caseMediaExternalId !== undefined &&
                      changedMediaExternalIds.has(row.caseMediaExternalId)),
                ),
              );
            }
            for (const row of manifest.templates) {
              incrementSeedOperation(
                templateCounts,
                await upsertTemplate(
                  tx,
                  row,
                  mediaIds,
                  changedMediaExternalIds.has(row.coverMediaExternalId) ||
                    (row.referenceMediaExternalId !== undefined &&
                      changedMediaExternalIds.has(row.referenceMediaExternalId)),
                ),
              );
            }
            for (const row of manifest.tools) {
              if (row.status === 'published') {
                validatePublishedTool(row);
                if (
                  !(await options.isModelSpecEnabled?.(row.defaultModelId, row.defaultOutputSpecId))
                )
                  throw new Error(`Tool ${row.externalId} requires an enabled model specification`);
                try {
                  await activeCreditPrice(
                    tx,
                    row.defaultModelId,
                    getOfficialOutputSpec(row.defaultModelId, row.defaultOutputSpecId)!.resolution,
                    409,
                  );
                } catch (error) {
                  if (
                    error instanceof Error &&
                    'code' in error &&
                    error.code === 'PRICE_UNAVAILABLE'
                  )
                    throw new Error(`Tool ${row.externalId} requires an active model credit price`);
                  throw error;
                }
              }
              incrementSeedOperation(
                toolCounts,
                await upsertTool(
                  tx,
                  row,
                  mediaIds,
                  changedMediaExternalIds.has(row.coverMediaExternalId) ||
                    (row.iconMediaExternalId !== undefined &&
                      changedMediaExternalIds.has(row.iconMediaExternalId)),
                ),
              );
            }
          });
          await Promise.all(
            obsoleteObjectKeys.map(async (key) => {
              try {
                await options.lifecycle?.beforeCleanup?.('obsolete');
                await store.delete(key);
              } catch {
                cleanupWarnings.obsolete++;
              }
            }),
          );
        } catch (error) {
          await Promise.all(
            newlyWritten.map(async (key) => {
              try {
                await options.lifecycle?.beforeCleanup?.('rollback');
                await store.delete(key);
              } catch {
                cleanupWarnings.rollback++;
              }
            }),
          );
          if (cleanupWarningCount(cleanupWarnings)) throw new SeedCleanupError(cleanupWarnings);
          throw error;
        }
      },
      options.lifecycle?.beforeLockAttempt,
      options.lifecycle?.afterLockAcquired,
    );
  } catch (error) {
    throw error;
  }
  return {
    media: manifest.media.length,
    inspirations: manifest.inspirations.length,
    templates: manifest.templates.length,
    tools: manifest.tools.length,
    mediaCounts,
    inspirationCounts,
    templateCounts,
    toolCounts,
    cleanupWarnings,
  };
}

type SeedOperation = 'created' | 'updated' | 'unchanged';
type SeedOperationCounts = Record<SeedOperation, number>;

function incrementSeedOperation(counts: SeedOperationCounts, operation: SeedOperation): void {
  counts[operation]++;
}

export class SeedCleanupError extends Error {
  readonly warningCount: number;

  constructor(readonly cleanupWarnings: CleanupWarningCounts) {
    const warningCount = cleanupWarningCount(cleanupWarnings);
    super(
      `Content seed failed with ${warningCount} cleanup warning(s): rollback=${cleanupWarnings.rollback}, obsolete=${cleanupWarnings.obsolete}`,
    );
    this.name = 'SeedCleanupError';
    this.warningCount = warningCount;
  }
}

type CleanupWarningCategory = 'rollback' | 'obsolete';
type CleanupWarningCounts = Record<CleanupWarningCategory, number>;

function cleanupWarningCount(warnings: CleanupWarningCounts): number {
  return warnings.rollback + warnings.obsolete;
}

function seedLockTimeoutMs(requestedTimeoutMs: number | undefined): number {
  if (requestedTimeoutMs === undefined) return 30_000;
  if (
    !Number.isInteger(requestedTimeoutMs) ||
    requestedTimeoutMs < 1 ||
    requestedTimeoutMs > 60_000
  )
    throw new Error('Content seed lock timeout must be an integer between 1 and 60000ms');
  return requestedTimeoutMs;
}

function validatePublishedTool(row: ContentSeedManifest['tools'][number]) {
  const definition = OFFICIAL_MODELS.find((model) => model.id === row.defaultModelId);
  const spec = getOfficialOutputSpec(row.defaultModelId, row.defaultOutputSpecId);
  if (
    !definition ||
    !spec ||
    spec.resolution !== row.defaults.resolution ||
    spec.ratio !== row.defaults.ratio
  )
    throw new Error(`Tool ${row.externalId} requires an exact output specification`);
  if (
    row.maxAssets > definition.maxImages ||
    row.maxOutputCount > 1 ||
    row.defaults.count > row.maxOutputCount
  )
    throw new Error(`Tool ${row.externalId} exceeds output/reference limits`);
}

async function upsertInspiration(
  tx: DbTransaction,
  row: ContentSeedManifest['inspirations'][number],
  mediaIds: Map<string, string>,
  mediaChanged = false,
) {
  const data = {
    title: row.title,
    description: row.description,
    category: row.category,
    creatorName: row.creatorName ?? null,
    sourceType: row.sourceType ?? null,
    sourceName: row.sourceName ?? null,
    sourceUrl: row.sourceUrl ?? null,
    editorialLabel: row.editorialLabel ?? null,
    baseLikes: row.baseLikes,
    tags: row.tags,
    defaultPrompt: row.defaultPrompt,
    defaultModelId: row.defaultModelId,
    defaultOutputSpecId: row.defaultOutputSpecId,
    coverMediaId: requiredMedia(mediaIds, row.coverMediaExternalId),
    caseMediaId: row.caseMediaExternalId ? requiredMedia(mediaIds, row.caseMediaExternalId) : null,
    status: row.status,
    sortOrder: row.sortOrder,
  };
  const current = await tx.inspiration.findUnique({ where: { externalId: row.externalId } });
  if (!current) {
    await tx.inspiration.create({
      data: {
        externalId: row.externalId,
        ...data,
        publishedAt: row.status === 'published' ? new Date() : null,
      },
    });
    return 'created';
  }
  if (sameRecord(current, data) && !mediaChanged) return 'unchanged';
  await tx.inspiration.update({
    where: { id: current.id },
    data: {
      ...data,
      version: { increment: 1 },
      publishedAt: row.status === 'published' ? (current.publishedAt ?? new Date()) : null,
    },
  });
  return 'updated';
}

async function upsertTemplate(
  tx: DbTransaction,
  row: ContentSeedManifest['templates'][number],
  mediaIds: Map<string, string>,
  mediaChanged = false,
) {
  const data = {
    title: row.title,
    description: row.description,
    category: row.category,
    platform: row.platform,
    industry: row.industry,
    style: row.style,
    creatorName: row.creatorName ?? null,
    sourceType: row.sourceType ?? null,
    sourceName: row.sourceName ?? null,
    sourceUrl: row.sourceUrl ?? null,
    popularityLabel: row.popularityLabel ?? null,
    baseRemixCount: row.baseRemixCount,
    tags: row.tags,
    visualAnalysis: row.visualAnalysis,
    defaultPrompt: row.defaultPrompt,
    defaultParameters: row.defaultParameters,
    defaultModelId: row.defaultModelId,
    defaultOutputSpecId: row.defaultOutputSpecId,
    coverMediaId: requiredMedia(mediaIds, row.coverMediaExternalId),
    referenceMediaId: row.referenceMediaExternalId
      ? requiredMedia(mediaIds, row.referenceMediaExternalId)
      : null,
    status: row.status,
    sortOrder: row.sortOrder,
  };
  const current = await tx.remixTemplate.findUnique({ where: { externalId: row.externalId } });
  if (!current) {
    await tx.remixTemplate.create({
      data: {
        externalId: row.externalId,
        ...data,
        publishedAt: row.status === 'published' ? new Date() : null,
      },
    });
    return 'created';
  }
  if (sameRecord(current, data) && !mediaChanged) return 'unchanged';
  await tx.remixTemplate.update({
    where: { id: current.id },
    data: {
      ...data,
      version: { increment: 1 },
      publishedAt: row.status === 'published' ? (current.publishedAt ?? new Date()) : null,
    },
  });
  return 'updated';
}

async function upsertTool(
  tx: DbTransaction,
  row: ContentSeedManifest['tools'][number],
  mediaIds: Map<string, string>,
  mediaChanged = false,
) {
  const data = {
    name: row.name,
    description: row.description,
    category: row.category,
    creatorName: row.creatorName ?? null,
    sourceType: row.sourceType ?? null,
    sourceName: row.sourceName ?? null,
    sourceUrl: row.sourceUrl ?? null,
    isNew: row.isNew,
    fieldSchema: row.fields,
    promptTemplate: row.promptTemplate,
    defaults: row.defaults,
    maxAssets: row.maxAssets,
    maxOutputCount: row.maxOutputCount,
    assetLabel: row.assetLabel,
    defaultModelId: row.defaultModelId,
    defaultOutputSpecId: row.defaultOutputSpecId,
    coverMediaId: requiredMedia(mediaIds, row.coverMediaExternalId),
    iconMediaId: row.iconMediaExternalId ? requiredMedia(mediaIds, row.iconMediaExternalId) : null,
    status: row.status,
    sortOrder: row.sortOrder,
  };
  const current = await tx.toolDefinition.findUnique({ where: { externalId: row.externalId } });
  if (!current) {
    await tx.toolDefinition.create({
      data: {
        externalId: row.externalId,
        ...data,
        publishedAt: row.status === 'published' ? new Date() : null,
      },
    });
    return 'created';
  }
  if (sameRecord(current, data) && !mediaChanged) return 'unchanged';
  await tx.toolDefinition.update({
    where: { id: current.id },
    data: {
      ...data,
      version: { increment: 1 },
      publishedAt: row.status === 'published' ? (current.publishedAt ?? new Date()) : null,
    },
  });
  return 'updated';
}

async function prepareMedia(row: ContentSeedManifest['media'][number]): Promise<PreparedMedia> {
  try {
    const source = trustedVisualSvg(row.seed, row.colors);
    const raster = await sharp(Buffer.from(source, 'utf8')).png().toBuffer();
    const image = await validateImage(raster);
    const hash = sha256(image.bytes);
    return {
      externalId: row.externalId,
      logicalFilename: row.logicalFilename,
      objectKey: `content/seed/${row.externalId}-${hash}.png`,
      sha256: hash,
      contentType: 'image/png',
      width: image.width,
      height: image.height,
      byteSize: image.bytes.byteLength,
      status: row.status,
      bytes: image.bytes,
    };
  } catch (error) {
    throw namedMediaError(row, error);
  }
}

function trustedVisualSvg(seed: string, colors: readonly [string, string, string]): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 960"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${colors[0]}"/><stop offset=".56" stop-color="${colors[1]}"/><stop offset="1" stop-color="${colors[2]}"/></linearGradient><filter id="b"><feGaussianBlur stdDeviation="36"/></filter></defs><rect width="960" height="960" fill="url(#g)"/><circle cx="710" cy="240" r="190" fill="none" stroke="#fff" stroke-opacity=".72" stroke-width="54"/><rect x="174" y="190" width="286" height="510" rx="118" fill="#fff" fill-opacity=".78"/><ellipse cx="360" cy="760" rx="260" ry="70" fill="#08090a" fill-opacity=".22" filter="url(#b)"/><path d="M0 780C210 650 380 940 610 760s350 20 350 20v180H0Z" fill="#fff" fill-opacity=".16"/><text x="62" y="88" fill="#fff" fill-opacity=".8" font-family="sans-serif" font-size="28">${seed}</text></svg>`;
}

function sameMedia(current: Record<string, unknown>, data: Record<string, unknown>): boolean {
  return sameRecord(current, data);
}

function sameRecord(current: Record<string, unknown>, data: Record<string, unknown>): boolean {
  return Object.entries(data).every(
    ([key, value]) => canonicalJson(current[key]) === canonicalJson(value),
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonical(nested)]),
    );
  return value;
}

function requiredMedia(mediaIds: Map<string, string>, externalId: string): string {
  const id = mediaIds.get(externalId);
  if (!id) throw new Error(`Unknown content media ${externalId}`);
  return id;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function namedMediaError(
  media: Pick<PreparedMedia, 'logicalFilename' | 'externalId'>,
  error: unknown,
): Error {
  const detail = error instanceof Error ? error.message : 'unknown storage error';
  return new Error(
    `Content media ${media.logicalFilename} (${media.externalId}) failed: ${detail}`,
  );
}

function createStore(config: AppConfig): ObjectStore {
  if (config.storageDriver === 'local') return new LocalObjectStore(config.localStorageRoot);
  return new S3ObjectStore({
    bucket: config.s3Bucket!,
    region: config.s3Region!,
    ...(config.s3Endpoint === undefined ? {} : { endpoint: config.s3Endpoint }),
    ...(config.s3AccessKeyId === undefined ? {} : { accessKeyId: config.s3AccessKeyId }),
    ...(config.s3SecretAccessKey === undefined
      ? {}
      : { secretAccessKey: config.s3SecretAccessKey }),
    forcePathStyle: config.s3ForcePathStyle,
  });
}

export async function seedContentCommand(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = loadConfig(env);
  const db = new DatabaseService(config.databaseUrl);
  try {
    await db.onModuleInit();
    const catalog = new CatalogService(db, config);
    const models = (await catalog.models()) as Array<{
      id: string;
      specs?: Array<{ id: string }>;
    }>;
    const enabled = new Set(
      models.flatMap((model) =>
        model.specs ? model.specs.map((spec) => `${model.id}:${spec.id}`) : [],
      ),
    );
    const result = await seedContent(db, createStore(config), {
      isModelSpecEnabled: (modelId, outputSpecId) => enabled.has(`${modelId}:${outputSpecId}`),
    });
    console.info(
      `Seeded content catalogs: ${result.media} media (${formatSeedCounts(result.mediaCounts)}), ${result.inspirations} inspirations (${formatSeedCounts(result.inspirationCounts)}), ${result.templates} templates (${formatSeedCounts(result.templateCounts)}), ${result.tools} tools (${formatSeedCounts(result.toolCounts)}); cleanup warnings rollback=${result.cleanupWarnings.rollback}, obsolete=${result.cleanupWarnings.obsolete}`,
    );
  } finally {
    await db.onModuleDestroy();
  }
}

function formatSeedCounts(counts: SeedOperationCounts): string {
  return `${counts.created} created, ${counts.updated} updated, ${counts.unchanged} unchanged`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedContentCommand().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Content seed failed');
    process.exitCode = 1;
  });
}
