import { api } from './api';
import type { GenerationInput, GenerationQuote, GenerationTask, OutputCount, RemixInput } from '@/src/types/domain';

export interface GenerationFlowResult {
  task: GenerationTask;
  quote: GenerationQuote;
}

type BackendGenerationInput = {
  source: 'create' | 'remix';
  modelId: string;
  prompt: string;
  resolution: string;
  ratio: string;
  format: 'png';
  quality: 'standard';
  count: number;
  referenceAssetId?: string;
  subjectAssetId?: string;
  strength?: 'similar' | 'balanced' | 'creative';
};

function backendCreateInput(input: GenerationInput): BackendGenerationInput {
  return {
    source: 'create',
    modelId: input.modelId,
    prompt: input.prompt,
    resolution: input.resolution,
    ratio: input.ratio,
    format: 'png',
    quality: 'standard',
    count: input.count,
  };
}

function backendRemixInput(input: RemixInput): BackendGenerationInput {
  return {
    source: 'remix',
    modelId: input.modelId,
    prompt: input.adaptation,
    resolution: input.resolution,
    ratio: input.ratio,
    format: 'png',
    quality: 'standard',
    count: input.count,
    ...(input.referenceAssetId ? { referenceAssetId: input.referenceAssetId } : {}),
    ...(input.subjectAssetId ? { subjectAssetId: input.subjectAssetId } : {}),
    strength: input.strength,
  };
}

function idempotencyKey(): string {
  return `web-${crypto.randomUUID()}`;
}

export async function createGeneration(input: GenerationInput): Promise<GenerationFlowResult> {
  const backendInput = backendCreateInput(input);
  const quote = await api.createGenerationQuote(backendInput);
  const task = await api.submitGenerationTask('generation', quote.id, backendInput, idempotencyKey());
  return { task, quote };
}

export async function createRemix(input: RemixInput): Promise<GenerationFlowResult> {
  const backendInput = backendRemixInput(input);
  const quote = await api.createGenerationQuote(backendInput);
  const task = await api.submitGenerationTask('remix', quote.id, backendInput, idempotencyKey());
  return { task, quote };
}

export async function retryGeneration(id: string): Promise<GenerationTask> {
  const previous = await api.getGenerationTask(id);
  const failedCount = previous.items?.filter((item) => item.status === 'failed').length ?? 0;
  if (failedCount < 1 || failedCount > 4) throw new Error('当前任务没有可重试的失败图片。');
  const source = previous.input.source === 'remix' ? 'remix' : 'create';
  const input: BackendGenerationInput = {
    source,
    modelId: previous.input.modelId,
    prompt: previous.input.prompt,
    resolution: previous.input.resolution,
    ratio: previous.input.ratio,
    format: 'png',
    quality: 'standard',
    count: failedCount as OutputCount,
    ...(previous.input.referenceAssetId ? { referenceAssetId: previous.input.referenceAssetId } : {}),
    ...(previous.input.subjectAssetId ? { subjectAssetId: previous.input.subjectAssetId } : {}),
    ...(source === 'remix' ? { strength: previous.input.strength ?? 'balanced' } : {}),
  };
  const quote = await api.createGenerationQuote(input);
  return api.retryGenerationTask(id, { quoteId: quote.id, input, idempotencyKey: idempotencyKey() });
}
