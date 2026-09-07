import { Queue, Worker } from 'bullmq';
import { z } from 'zod';
import { DatabaseService } from '../database/database.service.js';
import { DispatchService } from '../../modules/generation/dispatch.service.js';
import { RecoveryService } from '../../modules/generation/recovery.service.js';
import { OutboxPublisher } from './outbox-publisher.js';

export class QueueRuntime {
  readonly queue: Queue<{ itemId: string }>;
  readonly publisher: OutboxPublisher;
  readonly recovery: RecoveryService;
  deliveries = 0;
  private worker: Worker<{ itemId: string }> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: Promise<void> | undefined;
  private closed = false;
  private lastErrorAt = 0;
  constructor(
    db: DatabaseService,
    private readonly dispatch: DispatchService,
    private readonly redisUrl: string,
    private readonly namespace: string,
  ) {
    if (!/^[a-z0-9-]{3,80}$/.test(namespace)) throw new Error('Invalid queue namespace');
    this.queue = new Queue<{ itemId: string }>('image-jobs', {
      prefix: `viviai-${namespace}`,
      connection: { url: redisUrl, maxRetriesPerRequest: 1, enableOfflineQueue: false },
    });
    this.queue.on('error', () => this.reportError('queue_connection'));
    this.publisher = new OutboxPublisher(db, this.queue);
    this.recovery = new RecoveryService(db, dispatch);
  }
  async start(intervalMs = 1000): Promise<void> {
    if (this.worker || this.closed || !Number.isFinite(intervalMs) || intervalMs < 100)
      throw new Error('Queue runtime cannot be started');
    await this.queue.waitUntilReady();
    this.worker = new Worker<{ itemId: string }>(
      'image-jobs',
      async (job) => {
        if (!z.uuid().safeParse(job.data.itemId).success) throw new Error('Invalid item hint');
        this.deliveries++;
        await this.dispatch.process(job.data.itemId);
      },
      {
        prefix: `viviai-${this.namespace}`,
        connection: { url: this.redisUrl, maxRetriesPerRequest: null },
        concurrency: 4,
      },
    );
    this.worker.on('error', () => this.reportError('worker_connection'));
    this.worker.on('failed', () => this.reportError('worker_delivery'));
    await this.worker.waitUntilReady();
    const cycle = async (recover: boolean) => {
      if (this.closed) return;
      this.active = (async () => {
        try {
          await this.publisher.publishBatch();
        } catch {
          this.reportError('outbox_publish');
        }
        // SQL scan is independent of queue history; it also persists retry timing.
        if (recover)
          try {
            await this.recovery.scan();
          } catch {
            this.reportError('recovery_scan');
          }
      })();
      await this.active;
      if (!this.closed)
        this.timer = setTimeout(() => {
          void cycle(true);
        }, intervalMs);
    };
    void cycle(false);
  }
  private reportError(event: string) {
    if (Date.now() - this.lastErrorAt < 5000) return;
    this.lastErrorAt = Date.now();
    console.error(JSON.stringify({ level: 'error', component: 'image-worker', event }));
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    await this.active;
    await this.worker?.close();
    await this.queue.close();
  }
  async cleanupOwnedTestQueue(): Promise<void> {
    if (!this.closed || !/^test-[a-f0-9-]{36}$/.test(this.namespace))
      throw new Error('Cleanup only permits this closed, UUID-namespaced test queue');
    const queue = new Queue('image-jobs', {
      prefix: `viviai-${this.namespace}`,
      connection: { url: this.redisUrl, maxRetriesPerRequest: 1 },
    });
    try {
      await queue.obliterate({ force: true });
    } finally {
      await queue.close();
    }
  }
}
