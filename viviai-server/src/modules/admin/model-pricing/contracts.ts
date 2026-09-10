import { z } from 'zod';
import { OFFICIAL_MODELS, officialSpecs } from '../../providers/official-models.js';
import { parse } from '../auth.controller.js';
export const modelIdSchema = z.enum(OFFICIAL_MODELS.map((m) => m.id));
export const savePriceSchema = z
  .object({
    unitCredits: z.number().int().min(1).max(1_000_000),
    enabled: z.boolean(),
    expectedVersion: z.number().int().min(0).max(2147483647),
    reason: z.string().trim().min(5).max(500),
  })
  .strict();
export type SaveModelPrice = z.infer<typeof savePriceSchema>;
export function priceTuple(modelId: string, resolution: string) {
  parse(modelIdSchema, modelId);
  parse(
    z.string().refine((r) => officialSpecs(modelId).some((s) => s.resolution === r)),
    resolution,
  );
  return { modelId, resolution };
}
export type PriceState = { unitCredits: number; enabled: boolean; version: number };
export type ModelPriceRow = {
  modelId: string;
  name: string;
  provider: string;
  resolution: string;
  specs: { id: string; resolution: string; ratio: string; width: number; height: number }[];
  priceId: string | null;
  unitCredits: number | null;
  enabled: boolean;
  version: number;
  updatedAt: string | null;
  runtimeAvailable: boolean;
  availabilityReason: 'unpriced' | 'price_disabled' | 'runtime_unavailable' | 'available';
  allowedActions: {
    action: 'create' | 'edit' | 'enable' | 'disable';
    allowed: boolean;
    reasonCode: string | null;
  }[];
};
