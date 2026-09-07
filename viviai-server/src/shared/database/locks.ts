import type { DbTransaction } from './database.service.js';

// Every job/credit/worker mutation for a user takes this first. Reentrant within
// a transaction; all subsequent item/reservation/lot locks are nested beneath it.
export async function lockWallet(tx: DbTransaction, userId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`wallet:${userId}`}, 0))`;
}
export function safeInteger(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('Unsafe integer serialization');
  return Number(value);
}
