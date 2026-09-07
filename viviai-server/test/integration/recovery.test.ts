import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';
import { WalletService } from '../../src/modules/wallet/wallet.service.js';
import { CatalogService } from '../../src/modules/catalog/catalog.service.js';
import { GenerationService } from '../../src/modules/generation/generation.service.js';
import { loadConfig } from '../../src/config.js';
import { LocalObjectStore } from '../../src/modules/assets/local-object-store.js';
import { ProviderRegistry } from '../../src/modules/providers/registry.js';
import { DispatchService } from '../../src/modules/generation/dispatch.service.js';
import { QueueRuntime } from '../../src/shared/queue/queue-runtime.js';
describe('outbox replay and lost scheduling hints', () => {
  let db: TestDatabase;
  let root: string;
  let queue: QueueRuntime;
  let jobs: GenerationService;
  let wallet: WalletService;
  let catalog: CatalogService;
  beforeAll(async () => {
    db = await createTestDatabase();
    root = await mkdtemp(join(tmpdir(), 'viviai-recovery-test-'));
    const store = new LocalObjectStore(root);
    wallet = new WalletService(db.database);
    catalog = new CatalogService(db.database, loadConfig());
    jobs = new GenerationService(db.database, catalog, wallet);
    queue = new QueueRuntime(
      db.database,
      new DispatchService(db.database, wallet, store, new ProviderRegistry(store)),
      process.env.REDIS_URL!,
      `test-${randomUUID()}`,
    );
    await queue.queue.waitUntilReady();
  });
  afterAll(async () => {
    await queue?.close();
    if (queue) await queue.cleanupOwnedTestQueue();
    await db?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
  });
  it('replays publication without duplicate queue entries, then recovers after queue loss', async () => {
    const id = randomUUID();
    await db.database.client.user.create({
      data: { id, email: `${id}@example.test`, username: id, passwordHash: 'unused' },
    });
    await db.database.transaction((tx) => wallet.grant(tx, id, 'test', 100n, null));
    const input = { source: 'create', modelId: 'simulation-image-v1', prompt: 'test', count: 1 };
    const q = await catalog.quote(id, input);
    const job = await jobs.create(id, { quoteId: q.id, input }, randomUUID(), 'create');
    expect(await queue.publisher.publishBatch()).toBe(1);
    await db.database.client.outboxEvent.updateMany({
      where: { itemId: job.items[0]!.id },
      data: { publishedAt: null },
    });
    expect(await queue.publisher.publishBatch()).toBe(1);
    expect(await queue.queue.getJobCounts('waiting')).toMatchObject({ waiting: 1 });
    // This queue is a unique UUID-namespaced test resource; no Redis flush is used.
    await queue.queue.drain(true);
    expect(await queue.queue.getJobCounts('waiting')).toMatchObject({ waiting: 0 });
    await queue.recovery.scan();
    await db.database.client.generationItem.update({
      where: { id: job.items[0]!.id },
      data: { nextRunAt: new Date(0) },
    });
    await queue.recovery.scan();
    expect(await jobs.get(id, job.id)).toMatchObject({ status: 'succeeded', chargedCredits: 30 });
    expect(await wallet.balance(id)).toMatchObject({ available: 70n, held: 0n, consumed: 30n });
    expect(
      await db.database.client.providerAttempt.count({ where: { itemId: job.items[0]!.id } }),
    ).toBe(1);
  });
});
