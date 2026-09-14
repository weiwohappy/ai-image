import { z } from 'zod';
import { AppError } from '../../shared/http/errors.js';

export const toolQuoteInputSchema = z
  .object({
    toolId: z.string().regex(/^[a-z][a-z0-9-]{1,79}$/),
    toolVersion: z.number().int().positive(),
    assetIds: z.array(z.string().uuid()).max(4),
    values: z.record(z.string(), z.string().max(4000)),
    modelId: z.string().min(1).max(80),
    resolution: z.enum(['0.5K', '1K', '2K', '4K']),
    ratio: z.string().min(1).max(20),
    count: z.number().int().min(1).max(4),
  })
  .strict();

export type ToolQuoteInput = z.infer<typeof toolQuoteInputSchema>;

export function parseToolQuoteInput(raw: unknown): ToolQuoteInput {
  const parsed = toolQuoteInputSchema.safeParse(raw);
  if (!parsed.success)
    throw new AppError(422, 'INVALID_TOOL_INPUT', 'Invalid tool execution request');
  return parsed.data;
}
