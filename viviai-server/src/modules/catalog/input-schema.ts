import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../shared/http/errors.js';

export const PRODUCT_ID = 'simulation-image-v1';
export const inputSchema = z.object({
  source: z.enum(['create', 'remix']).default('create'),
  modelId: z.literal(PRODUCT_ID), prompt: z.string().trim().min(1).max(4000),
  resolution: z.literal('1K').default('1K'), ratio: z.literal('1:1').default('1:1'),
  format: z.literal('png').default('png'), quality: z.literal('standard').default('standard'),
  count: z.number().int().min(1).max(4),
  referenceAssetId: z.uuid().optional(), subjectAssetId: z.uuid().optional(),
  strength: z.enum(['similar', 'balanced', 'creative']).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.source === 'remix' && !value.referenceAssetId) ctx.addIssue({ code: 'custom', message: 'Reference is required' });
  if (value.source === 'create' && (value.referenceAssetId || value.subjectAssetId || value.strength)) ctx.addIssue({ code: 'custom', message: 'Image inputs require remix mode' });
  if (value.subjectAssetId && value.subjectAssetId === value.referenceAssetId) ctx.addIssue({ code: 'custom', message: 'Reference and subject must differ' });
}).transform(value => ({ ...value, ...(value.source === 'remix' ? { strength: value.strength ?? 'balanced' as const } : {}) }));
export type GenerationInput = z.infer<typeof inputSchema>;
export function normalizeInput(input: unknown): GenerationInput {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new AppError(400, 'INVALID_INPUT', 'Unsupported generation parameters');
  return parsed.data;
}
export function digest(value: unknown): string {
  function canonical(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(canonical);
    if (input !== null && typeof input === 'object') return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => [k,canonical(v)]));
    return input;
  }
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
