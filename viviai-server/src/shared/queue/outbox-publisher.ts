import type { Queue } from 'bullmq';
import { DatabaseService } from '../database/database.service.js';
export class OutboxPublisher {
  constructor(
    private readonly db: DatabaseService,
    private readonly queue: Queue<{ itemId: string }>,
  ) {}
  async publishBatch(): Promise<number> {
    const events = await this.db.client.outboxEvent.findMany({
      where: { publishedAt: null },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 100,
    });
    for (const event of events) {
      // A crash between Redis acceptance and the DB update replays the same key.
      await this.queue.add(
        'image-item',
        { itemId: event.itemId },
        {
          jobId: event.id,
          delay: Math.max(0, event.availableAt.getTime() - Date.now()),
          removeOnComplete: { age: 3600, count: 1000 },
          removeOnFail: { age: 86400, count: 1000 },
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
        },
      );
      await this.db.client.outboxEvent.updateMany({
        where: { id: event.id, publishedAt: null },
        data: { publishedAt: new Date() },
      });
    }
    return events.length;
  }
}
