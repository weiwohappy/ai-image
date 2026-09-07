import { DatabaseService } from '../../shared/database/database.service.js';
import { DispatchService } from './dispatch.service.js';
import { TERMINAL } from './job-serializer.js';
export class RecoveryService {
  constructor(
    private readonly db: DatabaseService,
    private readonly dispatch: DispatchService,
  ) {}
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
    return items.length;
  }
}
