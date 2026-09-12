import type {
  GenerationInput,
  GenerationTask,
  ImageAsset,
  ImageRatio,
  ModelConfig,
  ModelOutputSpec,
  Resolution,
  TaskStatus,
  PointLedgerEntry,
} from '@/src/types/domain';
import { apiResourceUrl } from './api';

type RecordLike = Record<string, unknown>;

function record(value: unknown): RecordLike {
  return value !== null && typeof value === 'object' ? (value as RecordLike) : {};
}

function list<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function validResolution(value: unknown): value is Resolution {
  return value === '0.5K' || value === '1K' || value === '2K' || value === '4K';
}

function validRatio(value: unknown): value is ImageRatio {
  return typeof value === 'string' && ['21:9', '16:9', '3:2', '5:4', '4:3', '1:1', '4:5', '3:4', '2:3', '9:16'].includes(value);
}

function normalizeSpec(value: unknown): ModelOutputSpec | undefined {
  const input = record(value);
  if (!validResolution(input.resolution) || !validRatio(input.ratio) || typeof input.id !== 'string' || !Number.isFinite(input.width) || !Number.isFinite(input.height)) return undefined;
  return {
    id: input.id,
    resolution: input.resolution,
    ratio: input.ratio,
    width: Number(input.width),
    height: Number(input.height),
    ...(typeof input.imageSize === 'string' ? { imageSize: input.imageSize } : {}),
    ...(Number.isFinite(input.unitCredits) ? { unitCredits: Number(input.unitCredits) } : {}),
  };
}

export function normalizeModelDto(value: unknown): ModelConfig {
  const input = record(value);
  const specs = list(input.specs).map(normalizeSpec).filter((item): item is ModelOutputSpec => Boolean(item));
  const resolutions = unique(list<unknown>(input.resolutions).filter(validResolution).concat(specs.map((item) => item.resolution)));
  const ratios = unique(list<unknown>(input.ratios).filter(validRatio).concat(specs.map((item) => item.ratio)));
  const qualities = list<unknown>(input.qualities).filter((item): item is 'low' | 'medium' | 'high' => item === 'low' || item === 'medium' || item === 'high');
  const status = input.status === 'unavailable' ? 'unavailable' : 'available';
  return {
    id: typeof input.id === 'string' ? input.id : '',
    name: typeof input.name === 'string' ? input.name : '未命名模型',
    description: typeof input.description === 'string' ? input.description : input.simulated ? '开发测试模型' : '服务端图片模型',
    ...(input.recommended === true ? { recommended: true } : {}),
    resolutions,
    ratios,
    ...(qualities.length ? { qualities } : {}),
    status,
    ...(typeof input.simulated === 'boolean' ? { simulated: input.simulated } : {}),
    ...(list<unknown>(input.formats).includes('png') ? { formats: ['png'] as const } : {}),
    ...(Number.isInteger(input.maxReferenceImages) ? { maxReferenceImages: Number(input.maxReferenceImages) } : {}),
    ...(Number.isFinite(input.unitCredits) ? { unitCredits: Number(input.unitCredits) } : {}),
    ...(specs.length ? { specs } : {}),
  };
}

function normalizeInput(value: unknown): GenerationInput {
  const input = record(value);
  const source = input.source === 'create' ? 'generation' : input.source;
  return {
    prompt: typeof input.prompt === 'string' ? input.prompt : '',
    modelId: typeof input.modelId === 'string' ? input.modelId : '',
    resolution: validResolution(input.resolution) ? input.resolution : '1K',
    ratio: validRatio(input.ratio) ? input.ratio : '1:1',
    count: Number.isInteger(input.count) ? Number(input.count) as GenerationInput['count'] : 1,
    ...(input.quality === 'low' || input.quality === 'medium' || input.quality === 'high' ? { quality: input.quality } : {}),
    ...(typeof input.referenceAssetId === 'string' ? { referenceAssetId: input.referenceAssetId } : {}),
    ...(Array.isArray(input.referenceAssetIds) ? { referenceAssetIds: input.referenceAssetIds.filter((item): item is string => typeof item === 'string') } : {}),
    ...(input.strength === 'similar' || input.strength === 'balanced' || input.strength === 'creative' ? { strength: input.strength } : {}),
    ...(source === 'generation' || source === 'remix' || source === 'tool' || source === 'workflow' ? { source } : {}),
  };
}

export function normalizeTaskDto(value: unknown): GenerationTask {
  const input = record(value);
  const items = list(input.items).map((item) => {
    const row = record(item);
    return {
      id: typeof row.id === 'string' ? row.id : '',
      ordinal: Number.isInteger(row.ordinal) ? Number(row.ordinal) : 0,
      status: (typeof row.status === 'string' ? row.status : 'failed') as TaskStatus,
      ...(typeof row.resultAssetId === 'string' || row.resultAssetId === null ? { resultAssetId: row.resultAssetId } : {}),
      ...(typeof row.errorCode === 'string' || row.errorCode === null ? { errorCode: row.errorCode } : {}),
    };
  });
  return {
    id: typeof input.id === 'string' ? input.id : '',
    input: normalizeInput(input.input),
    status: (typeof input.status === 'string' ? input.status : 'failed') as TaskStatus,
    progress: Number.isFinite(input.progress) ? Number(input.progress) : 0,
    estimatedCredits: Number.isFinite(input.estimatedCredits) ? Number(input.estimatedCredits) : 0,
    chargedCredits: Number.isFinite(input.chargedCredits) ? Number(input.chargedCredits) : 0,
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : new Date(0).toISOString(),
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : new Date(0).toISOString(),
    resultAssetIds: list<unknown>(input.resultAssetIds).filter((item): item is string => typeof item === 'string'),
    ...(typeof input.stage === 'string' ? { stage: input.stage } : {}),
    ...(typeof input.cancelRequested === 'boolean' ? { cancelRequested: input.cancelRequested } : {}),
    ...(items.length ? { items } : {}),
    ...(typeof input.templateId === 'string' ? { templateId: input.templateId } : {}),
    ...(Number.isInteger(input.templateVersion) ? { templateVersion: Number(input.templateVersion) } : {}),
    ...(input.remixStrength === 'similar' || input.remixStrength === 'balanced' || input.remixStrength === 'creative' ? { remixStrength: input.remixStrength } : {}),
    ...(typeof input.toolId === 'string' ? { toolId: input.toolId } : {}),
    ...(typeof input.workflowId === 'string' ? { workflowId: input.workflowId } : {}),
    ...(typeof input.batchId === 'string' ? { batchId: input.batchId } : {}),
    ...(typeof input.workflowRowId === 'string' ? { workflowRowId: input.workflowRowId } : {}),
    ...(typeof input.workflowColumnId === 'string' ? { workflowColumnId: input.workflowColumnId } : {}),
    ...(typeof input.errorCode === 'string' ? { errorCode: input.errorCode as GenerationTask['errorCode'] } : {}),
    ...(typeof input.errorMessage === 'string' ? { errorMessage: input.errorMessage } : {}),
  };
}

export function normalizeAssetDto(value: unknown): ImageAsset {
  const input = record(value);
  const id = typeof input.id === 'string' ? input.id : '';
  const contentPath = `/assets/${id}/content`;
  const imagePath = typeof input.imageUrl === 'string' ? input.imageUrl : contentPath;
  const thumbnailPath = typeof input.thumbnailUrl === 'string' ? input.thumbnailUrl : imagePath;
  return {
    id,
    name: typeof input.name === 'string' ? input.name : '未命名资产',
    imageUrl: apiResourceUrl(imagePath),
    thumbnailUrl: apiResourceUrl(thumbnailPath),
    width: Number.isFinite(input.width) ? Number(input.width) : 0,
    height: Number.isFinite(input.height) ? Number(input.height) : 0,
    source: input.source === 'remix' || input.source === 'tool' || input.source === 'workflow' || input.source === 'upload' ? input.source : 'generation',
    favorite: input.favorite === true,
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : new Date(0).toISOString(),
    ...(typeof input.modelId === 'string' ? { modelId: input.modelId } : {}),
    ...(typeof input.prompt === 'string' ? { prompt: input.prompt } : {}),
    ...(typeof input.templateId === 'string' ? { templateId: input.templateId } : {}),
    ...(Number.isInteger(input.templateVersion) ? { templateVersion: Number(input.templateVersion) } : {}),
    ...(input.remixStrength === 'similar' || input.remixStrength === 'balanced' || input.remixStrength === 'creative' ? { remixStrength: input.remixStrength } : {}),
  };
}

export function assetContentUrl(id: string): string {
  return apiResourceUrl(`/assets/${encodeURIComponent(id)}/content`);
}

export function normalizeLedgerDtos(value: unknown): PointLedgerEntry[] {
  const records = list(value).map(record);
  let balance = 0;
  const normalized = records
    .slice()
    .reverse()
    .map((input) => {
      const delta = Number.isFinite(input.delta) ? Number(input.delta) : Number.isFinite(input.amount) ? Number(input.amount) : Number.isFinite(input.availableDelta) ? Number(input.availableDelta) : 0;
      balance += delta;
      const rawType = typeof input.type === 'string' ? input.type : '';
      const type: PointLedgerEntry['type'] = rawType === 'paid_grant' || rawType === 'promotional_grant' ? 'purchase' : rawType === 'release' || rawType === 'expire' || rawType === 'refund' ? 'refund' : rawType === 'consume' ? 'consume' : rawType === 'freeze' ? 'freeze' : rawType === 'redeem' ? 'redeem' : rawType === 'invite' ? 'invite' : 'register';
      const description = typeof input.description === 'string' ? input.description : rawType === 'paid_grant' ? '购买积分到账' : rawType === 'promotional_grant' ? '活动积分到账' : rawType === 'freeze' ? '任务冻结积分' : rawType === 'consume' ? '任务消耗积分' : rawType === 'release' ? '任务取消退回' : rawType === 'expire' ? '积分过期' : rawType || '积分变动';
      return {
        id: typeof input.id === 'string' ? input.id : crypto.randomUUID(),
        type,
        description,
        delta,
        balance: Number.isFinite(input.balance) ? Number(input.balance) : balance,
        createdAt: typeof input.createdAt === 'string' ? input.createdAt : new Date(0).toISOString(),
      };
    });
  return normalized.reverse();
}
