import type { DbTransaction } from '../../shared/database/database.service.js';
// Called only inside existing wallet-locked lifecycle transactions; never backfills history.
export async function recordLifecycle(
  tx: DbTransaction,
  itemId: string,
  event: 'dispatched' | 'accepted' | 'materializing' | 'delivered' | 'failed' | 'cancelled',
  now = new Date(),
) {
  await tx.generationLifecycleEvent.createMany({
    data: [{ itemId, event, createdAt: now }],
    skipDuplicates: true,
  });
}
