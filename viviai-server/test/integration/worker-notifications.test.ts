import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';
import { loadConfig } from '../../src/config.js';
import { LocalObjectStore } from '../../src/modules/assets/local-object-store.js';
import { CatalogService } from '../../src/modules/catalog/catalog.service.js';
import { GenerationService } from '../../src/modules/generation/generation.service.js';
import { WalletService } from '../../src/modules/wallet/wallet.service.js';
import { ProviderRegistry } from '../../src/modules/providers/registry.js';
import { DispatchService } from '../../src/modules/generation/dispatch.service.js';
import { SimulatedProvider } from '../../src/modules/providers/simulated-provider.js';
import { SIMULATED_PROFILES } from '../../src/modules/providers/provider-config.js';

describe('terminal generation job notifications', () => {
  let db: TestDatabase;
  let root: string;
  let store: LocalObjectStore;
  let wallet: WalletService;
  let jobs: GenerationService;

  beforeAll(async () => {
    db = await createTestDatabase();
    root = await mkdtemp(join(tmpdir(), 'viviai-worker-notify-'));
    store = new LocalObjectStore(root);
    wallet = new WalletService(db.database);
    jobs = new GenerationService(
      db.database,
      new CatalogService(db.database, loadConfig()),
      wallet,
    );
  });

  afterAll(async () => {
    await db?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function job(count = 1) {
    const id = randomUUID();
    await db.database.client.user.create({
      data: { id, email: `${id}@example.test`, username: id, passwordHash: 'unused' },
    });
    await db.database.transaction((tx) => wallet.grant(tx, id, 'test', 1000n, null));
    const input = { source: 'create', modelId: 'simulation-image-v1', prompt: 'test', count };
    const quote = await new CatalogService(db.database, loadConfig()).quote(id, input);
    return {
      userId: id,
      job: await jobs.create(id, { quoteId: quote.id, input }, randomUUID(), 'create'),
    };
  }

  function channel(adapter: SimulatedProvider) {
    return {
      adapter,
      profile: {
        ...SIMULATED_PROFILES[1]!,
        id: `notify-${randomUUID()}`,
        quotaScope: randomUUID(),
        budgetScope: randomUUID(),
      },
    };
  }

  const worker = (adapter: SimulatedProvider) =>
    new DispatchService(db.database, wallet, store, new ProviderRegistry(store, [channel(adapter)]));

  const terminalNotices = (jobId: string) =>
    db.database.client.notification.findMany({
      where: { eventKey: `generation-terminal:${jobId}` },
    });

  it('emits exactly one terminal notification only after every item settles', async () => {
    const dispatch = worker(new SimulatedProvider(store, 'sync'));
    const task = await job(2);
    const first = task.job.items[0]!.id;
    const second = task.job.items[1]!.id;

    await dispatch.process(first);
    // A sibling item is still queued, so no terminal notification may exist yet.
    expect(await terminalNotices(task.job.id)).toHaveLength(0);

    await dispatch.process(second);
    const notices = await terminalNotices(task.job.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      userId: task.userId,
      type: 'task',
      action: { href: '/tasks', jobId: task.job.id },
    });
    expect(JSON.stringify(notices[0]!.action)).not.toContain('prompt');
    expect(JSON.stringify(notices[0]!.action)).not.toContain('output');

    // Duplicate delivery never duplicates the notification.
    await dispatch.process(second);
    expect(await terminalNotices(task.job.id)).toHaveLength(1);
  });

  it('emits a single failure notification when the whole job fails', async () => {
    const adapter = new SimulatedProvider(store, 'sync');
    adapter.submit = async () => ({
      kind: 'rejected',
      failure: {
        code: 'content_rejected',
        acceptance: 'not_accepted',
        billing: 'not_billable',
        safeMessage: 'Simulation rejection',
      },
    });
    const dispatch = worker(adapter);
    const task = await job(2);
    for (const item of task.job.items) await dispatch.process(item.id);

    const notices = await terminalNotices(task.job.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ userId: task.userId, type: 'task', title: '任务失败' });
  });
});
