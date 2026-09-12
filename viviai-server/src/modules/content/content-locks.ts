import type { DbTransaction } from '../../shared/database/database.service.js';

export async function lockContentResources(tx: DbTransaction, keys: string[]): Promise<void> {
  for (const key of [...new Set(keys)].sort())
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`content:resource:${key}`}, 0))`;
}
