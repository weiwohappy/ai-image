import { z } from 'zod';
import { AppError } from '../../shared/http/errors.js';
import { getOfficialOutputSpec } from '../providers/official-models.js';
import {
  generationDefaultsSchema,
  toolFieldArraySchema,
  visualAnalysisSchema,
} from './content-contracts.js';

type MediaReference = { externalId: string } | null;
type Interaction = { userId: string };

const sourceTypeSchema = z.enum(['platform', 'licensed-user', 'brand', 'public-domain']);
const defaultParametersSchema = z
  .object({ strength: z.enum(['similar', 'balanced', 'creative']).optional() })
  .strict();

function invalidStoredContent(): never {
  throw new AppError(500, 'CONTENT_DATA_INVALID', 'Published content is unavailable');
}

function parseStored<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : invalidStoredContent();
}

function mediaUrl(media: MediaReference): string {
  if (!media) return invalidStoredContent();
  return `/api/content-media/${encodeURIComponent(media.externalId)}/content`;
}

export interface InspirationProjection {
  externalId: string;
  title: string;
  category: string;
  creatorName: string | null;
  sourceName: string | null;
  defaultPrompt: string;
  baseLikes: number;
  coverMedia: MediaReference;
  likes?: Interaction[];
  _count: { likes: number };
}

export function presentInspiration(row: InspirationProjection) {
  const likes = row.baseLikes + row._count.likes;
  if (!Number.isSafeInteger(likes) || likes < 0) return invalidStoredContent();
  return {
    id: row.externalId,
    title: row.title,
    imageUrl: mediaUrl(row.coverMedia),
    prompt: row.defaultPrompt,
    category: row.category,
    creator: row.creatorName ?? row.sourceName ?? 'VIVIAI',
    likes,
    liked: (row.likes?.length ?? 0) > 0,
  };
}

export interface RemixTemplateProjection {
  externalId: string;
  version: number;
  title: string;
  category: string;
  platform: string;
  industry: string;
  style: string;
  tags: string[];
  sourceType: string | null;
  popularityLabel: string | null;
  baseRemixCount: number;
  visualAnalysis: unknown;
  defaultParameters: unknown;
  defaultModelId: string;
  defaultOutputSpecId: string;
  coverMedia: MediaReference;
  favorites?: Interaction[];
}

export function presentRemixTemplate(row: RemixTemplateProjection) {
  const sourceType = parseStored(sourceTypeSchema, row.sourceType);
  const analysis = parseStored(visualAnalysisSchema, row.visualAnalysis);
  parseStored(defaultParametersSchema, row.defaultParameters);
  const outputSpec = getOfficialOutputSpec(row.defaultModelId, row.defaultOutputSpecId);
  if (!outputSpec || !Number.isSafeInteger(row.baseRemixCount) || row.baseRemixCount < 0)
    return invalidStoredContent();
  return {
    id: row.externalId,
    version: row.version,
    title: row.title,
    coverUrl: mediaUrl(row.coverMedia),
    category: row.category,
    platform: row.platform,
    industry: row.industry,
    style: row.style,
    tags: row.tags,
    recommendedModelId: row.defaultModelId,
    recommendedRatio: outputSpec.ratio,
    sourceType,
    popularityLabel: row.popularityLabel ?? '编辑精选',
    remixCount: row.baseRemixCount,
    favorite: (row.favorites?.length ?? 0) > 0,
    status: 'active' as const,
    analysis,
  };
}

export interface ToolDefinitionProjection {
  externalId: string;
  name: string;
  description: string;
  category: string;
  isNew: boolean;
  fieldSchema: unknown;
  defaults: unknown;
  maxAssets: number;
  assetLabel: string;
  defaultModelId: string;
  defaultOutputSpecId: string;
  maxOutputCount: number;
  coverMedia: MediaReference;
}

export function presentToolDefinition(row: ToolDefinitionProjection) {
  const fields = parseStored(toolFieldArraySchema, row.fieldSchema);
  const defaults = parseStored(generationDefaultsSchema, row.defaults);
  const outputSpec = getOfficialOutputSpec(row.defaultModelId, row.defaultOutputSpecId);
  if (
    !outputSpec ||
    defaults.modelId !== row.defaultModelId ||
    defaults.resolution !== outputSpec.resolution ||
    defaults.ratio !== outputSpec.ratio ||
    defaults.count > row.maxOutputCount ||
    !Number.isSafeInteger(row.maxAssets) ||
    row.maxAssets < 0
  )
    return invalidStoredContent();
  return {
    id: row.externalId,
    name: row.name,
    description: row.description,
    category: row.category,
    ...(row.isNew ? { isNew: true } : {}),
    coverUrl: mediaUrl(row.coverMedia),
    maxAssets: row.maxAssets,
    assetLabel: row.assetLabel,
    fields,
    defaults,
  };
}
