import type { DatabaseService } from '../../../shared/database/database.service.js';
import { z } from 'zod';
import { lockCreditPrice } from '../../catalog/credit-pricing.js';
import { AdminAuditService } from '../audit.service.js';
import { modelIdSchema, priceTuple } from './contracts.js';
type Candidate = { modelId: string; resolution: string; unitCredits: number };
export function parseLegacyPrices(raw: string): Candidate[] {
  if (!raw.trim()) return [];
  try {
    // Deliberately parse only public sales fields; never require or return credentials.
    const settings = z
      .object({
        models: z
          .array(
            z.object({
              modelId: modelIdSchema,
              sales: z.record(z.string(), z.number().int().min(1).max(1_000_000)).optional(),
            }),
          )
          .max(5),
      })
      .parse(JSON.parse(raw));
    if (new Set(settings.models.map((m) => m.modelId)).size !== settings.models.length)
      throw new Error();
    return settings.models.flatMap((m) =>
      Object.entries(m.sales ?? {}).map(([resolution, unitCredits]) => ({
        ...priceTuple(m.modelId, resolution),
        unitCredits,
      })),
    );
  } catch {
    throw new Error('Invalid legacy model credit prices');
  }
}
export async function importLegacyPrices(
  db: DatabaseService,
  config: { nodeEnv: string; host: string; databaseUrl: string },
  raw: string,
  apply = false,
) {
  const candidates = parseLegacyPrices(raw);
  if (
    apply &&
    (config.nodeEnv !== 'development' ||
      !['localhost', '127.0.0.1', '::1'].includes(config.host) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.databaseUrl).hostname))
  )
    throw new Error('Price import apply requires a loopback development database and host');
  const audit = new AdminAuditService();
  const items = [];
  for (const candidate of candidates) {
    const result = await db.transaction(async (tx) => {
      if (apply) await lockCreditPrice(tx, candidate.modelId, candidate.resolution);
      const existing = await tx.modelCreditPrice.findUnique({
        where: {
          modelId_resolution: { modelId: candidate.modelId, resolution: candidate.resolution },
        },
      });
      if (existing)
        return {
          ...candidate,
          outcome: 'exists' as const,
          resourceId: existing.id,
          version: existing.version,
        };
      if (!apply) return { ...candidate, outcome: 'would_create' as const };
      const row = await tx.modelCreditPrice.create({ data: { ...candidate, enabled: true } });
      await audit.write(
        tx,
        'model-pricing.import',
        'allowed',
        undefined,
        undefined,
        row.id,
        undefined,
        {
          modelId: row.modelId,
          resolution: row.resolution,
          source: 'offline_import',
          beforeUnitCredits: null,
          afterUnitCredits: row.unitCredits,
          beforeEnabled: null,
          afterEnabled: true,
          beforeVersion: 0,
          afterVersion: 1,
          changedFields: ['unitCredits', 'enabled'],
        },
      );
      return {
        ...candidate,
        outcome: 'created' as const,
        resourceId: row.id,
        version: row.version,
      };
    });
    items.push(result);
  }
  return { apply, items };
}
