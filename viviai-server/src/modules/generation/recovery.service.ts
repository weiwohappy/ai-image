import { DatabaseService } from '../../shared/database/database.service.js';
import { BatchProjectionService, RUN_ACTIVE } from '../workflow/batch-projection.service.js';
import { DispatchService } from './dispatch.service.js';
import { TERMINAL } from './job-serializer.js';
const IDLE_BEFORE_SWEEP_MS = 60_000;
export class RecoveryService {
  private readonly batches: BatchProjectionService;
  constructor(
    private readonly db: DatabaseService,
    private readonly dispatch: DispatchService,
  ) {
    this.batches = new BatchProjectionService(db);
  }
  async scan(now = new Date()): Promise<number> {
    const items = await this.db.client.generationItem.findMany({
      where: {
        status: { notIn: TERMINAL },
        OR: [
          { nextRunAt: { lte: now } },
          { job: { deliveryDeadlineAt: { lte: now } } },
          { status: 'queued', job: { queueDeadlineAt: { lte: now } } },
          { status: 'submitting', leaseUntil: { lte: now } },
        ],
      },
      orderBy: [{ nextRunAt: 'asc' }, { id: 'asc' }],
      take: 100,
    });
    for (const item of items) await this.dispatch.process(item.id);
    await this.sweepBatches(now);
    return items.length;
  }
  /**
   * Re-projects batches left idle in an active state, so a run whose counts went
   * stale is healed. Reconcile recomputes from the linked jobs, so repeating a
   * sweep can never double count.
   */
  private async sweepBatches(now: Date) {
    const stale = await this.db.client.workflowRun.findMany({
      where: {
        status: { in: RUN_ACTIVE },
        updatedAt: { lte: new Date(now.getTime() - IDLE_BEFORE_SWEEP_MS) },
      },
      select: { id: true },
      orderBy: { updatedAt: 'asc' },
      take: 50,
    });
    for (const run of stale)
      await this.db.transaction((tx) => this.batches.reconcile(tx, run.id));
  }
}
