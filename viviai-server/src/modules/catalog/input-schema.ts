import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../shared/http/errors.js';
import { OFFICIAL_MODELS, officialSpecs } from '../providers/official-models.js';

export const PRODUCT_ID = 'simulation-image-v1';
export const inputSchema = z
  .object({
    source: z.enum(['create', 'remix']).default('create'),
    modelId: z.enum([PRODUCT_ID, ...OFFICIAL_MODELS.map((m) => m.id)]),
    prompt: z.string().trim().min(1).max(4000),
    resolution: z.enum(['0.5K', '1K', '2K', '4K']).default('1K'),
    ratio: z
      .enum(['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'])
      .default('1:1'),
    format: z.literal('png').default('png'),
    quality: z.literal('standard').default('standard'),
    count: z.number().int().min(1).max(4),
    referenceAssetId: z.uuid().optional(),
    subjectAssetId: z.uuid().optional(),
    strength: z.enum(['similar', 'balanced', 'creative']).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const validSize =
      value.modelId === PRODUCT_ID
        ? value.resolution === '1K' && value.ratio === '1:1'
        : officialSpecs(value.modelId).some(
            (s) => s.resolution === value.resolution && s.ratio === value.ratio,
          );
    if (!validSize)
      ctx.addIssue({ code: 'custom', message: 'Unsupported model resolution and ratio' });
    if (value.modelId === 'gemini-3.1-flash-lite-image' && value.subjectAssetId)
      ctx.addIssue({ code: 'custom', message: 'Lite supports one reference in this product' });
    if (value.source === 'remix' && !value.referenceAssetId)
      ctx.addIssue({ code: 'custom', message: 'Reference is required' });
    if (
      value.source === 'create' &&
      (value.referenceAssetId || value.subjectAssetId || value.strength)
    )
      ctx.addIssue({ code: 'custom', message: 'Image inputs require remix mode' });
    if (value.subjectAssetId && value.subjectAssetId === value.referenceAssetId)
      ctx.addIssue({ code: 'custom', message: 'Reference and subject must differ' });
  })
  .transform((value) => ({
    ...value,
    ...(value.source === 'remix' ? { strength: value.strength ?? ('balanced' as const) } : {}),
  }));
export type GenerationInput = z.infer<typeof inputSchema>;
export function normalizeInput(input: unknown): GenerationInput {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success)
    throw new AppError(400, 'INVALID_INPUT', 'Unsupported generation parameters');
  return parsed.data;
}
export function digest(value: unknown): string {
  function canonical(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(canonical);
    if (input !== null && typeof input === 'object')
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, canonical(v)]),
      );
    return input;
  }
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
