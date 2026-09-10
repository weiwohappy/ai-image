import { z } from 'zod';
import type { DbTransaction } from '../../shared/database/database.service.js';
import { AppError } from '../../shared/http/errors.js';
export const creditPriceSchema = z
  .object({
    priceId: z.uuid(),
    version: z.number().int().min(1).max(2147483647),
    modelId: z.string(),
    resolution: z.string(),
    unitCredits: z.number().int().min(1).max(1_000_000),
  })
  .strict();
export type CreditPriceSnapshot = z.infer<typeof creditPriceSchema>;
export async function lockCreditPrice(tx: DbTransaction, modelId: string, resolution: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`model-credit-price:${modelId}:${resolution}`}, 0))`;
}
// The caller owns the transaction and holds this lock until quote/submit/write commits.
export async function activeCreditPrice(
  tx: DbTransaction,
  modelId: string,
  resolution: string,
  status: 409 | 503,
): Promise<CreditPriceSnapshot> {
  await lockCreditPrice(tx, modelId, resolution);
  const price = await tx.modelCreditPrice.findUnique({
    where: { modelId_resolution: { modelId, resolution } },
  });
  if (!price?.enabled)
    throw new AppError(status, 'PRICE_UNAVAILABLE', 'Model price is unavailable');
  return {
    priceId: price.id,
    version: price.version,
    modelId,
    resolution,
    unitCredits: price.unitCredits,
  };
}
