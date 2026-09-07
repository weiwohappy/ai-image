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
import { RecoveryService } from '../../src/modules/generation/recovery.service.js';
import { SimulatedProvider } from '../../src/modules/providers/simulated-provider.js';
import { SIMULATED_PROFILES } from '../../src/modules/providers/provider-config.js';
import type {
  ProviderAdapter,
  SubmitResult,
  NormalizedImageRequest,
  ProviderContext,
} from '../../src/modules/providers/contracts.js';
import type { ObjectStore } from '../../src/modules/assets/object-store.js';

describe('recoverable simulated image delivery', () => {
  let db: TestDatabase;
  let root: string;
  let store: LocalObjectStore;
  let wallet: WalletService;
  let jobs: GenerationService;
  let registry: ProviderRegistry;
  let dispatch: DispatchService;
  beforeAll(async () => {
    db = await createTestDatabase();
    root = await mkdtemp(join(tmpdir(), 'viviai-worker-test-'));
    store = new LocalObjectStore(root);
    wallet = new WalletService(db.database);
    jobs = new GenerationService(
      db.database,
      new CatalogService(db.database, loadConfig()),
      wallet,
    );
    registry = new ProviderRegistry(store);
    dispatch = new DispatchService(db.database, wallet, store, registry);
  });
  afterAll(async () => {
    await db?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
  });
  async function job(count = 1, localJobs = jobs) {
    const id = randomUUID();
    await db.database.client.user.create({
      data: { id, email: `${id}@example.test`, username: id, passwordHash: 'unused' },
    });
    await db.database.transaction((tx) => wallet.grant(tx, id, 'test', 1000n, null));
    const input = { source: 'create', modelId: 'simulation-image-v1', prompt: 'test', count };
    const quote = await new CatalogService(db.database, loadConfig()).quote(id, input);
    return {
      userId: id,
      job: await localJobs.create(id, { quoteId: quote.id, input }, randomUUID(), 'create'),
    };
  }
  function isolated(
    adapter: ProviderAdapter,
    suffix = randomUUID(),
    objectStore: ObjectStore = store,
  ) {
    const profile = {
      ...SIMULATED_PROFILES[1]!,
      id: `test-${suffix}`,
      quotaScope: suffix,
      budgetScope: suffix,
    };
    return {
      profile,
      dispatch: new DispatchService(
        db.database,
        wallet,
        objectStore,
        new ProviderRegistry(objectStore, [{ profile, adapter }]),
      ),
    };
  }
  const due = (id: string) =>
    db.database.client.generationItem.update({ where: { id }, data: { nextRunAt: new Date(0) } });
  it('settles a four-image partial result by item, not by whole job', async () => {
    const adapter = new SimulatedProvider(store, 'sync');
    const normalSubmit = adapter.submit.bind(adapter);
    let calls = 0;
    adapter.submit = async (r, c) =>
      ++calls <= 2
        ? normalSubmit(r, c)
        : {
            kind: 'rejected',
            failure: {
              code: 'content_rejected',
              acceptance: 'not_accepted',
              billing: 'not_billable',
              safeMessage: 'Simulation rejection',
            },
          };
    const worker = isolated(adapter).dispatch;
    const task = await job(4);
    for (const item of task.job.items) await worker.process(item.id);
    expect(await jobs.get(task.userId, task.job.id)).toMatchObject({
      status: 'partial',
      chargedCredits: 60,
    });
    expect(await wallet.balance(task.userId)).toMatchObject({
      available: 940n,
      held: 0n,
      consumed: 60n,
    });
  });
  it('fails over only after confirmed not-accepted; never after unknown', async () => {
    for (const acceptance of ['not_accepted', 'unknown'] as const) {
      const scope = randomUUID();
      const first = new SimulatedProvider(store, 'sync');
      const second = new SimulatedProvider(store, 'sync');
      let calls = 0;
      const original = second.submit.bind(second);
      second.submit = async (r, c) => {
        calls++;
        return original(r, c);
      };
      first.submit = async () =>
        acceptance === 'unknown'
          ? {
              kind: 'unknown',
              failure: { code: 'timeout', acceptance, billing: 'unknown', safeMessage: 'Unknown' },
            }
          : {
              kind: 'rejected',
              failure: {
                code: 'server_error',
                acceptance,
                billing: 'not_billable',
                safeMessage: 'Not accepted',
              },
            };
      const channels = [first, second].map((adapter, index) => ({
        adapter,
        profile: {
          ...SIMULATED_PROFILES[index]!,
          id: `${scope}-${index}`,
          quotaScope: scope,
          budgetScope: scope,
        },
      }));
      const worker = new DispatchService(
        db.database,
        wallet,
        store,
        new ProviderRegistry(store, channels),
      );
      const task = await job();
      const id = task.job.items[0]!.id;
      await worker.process(id);
      await due(id);
      await worker.process(id);
      expect(calls).toBe(acceptance === 'unknown' ? 0 : 1);
      expect(await db.database.client.providerAttempt.count({ where: { itemId: id } })).toBe(
        acceptance === 'unknown' ? 1 : 2,
      );
    }
  });
  it('retries output persistence on the same attempt without resubmission', async () => {
    let fail = true;
    const flaky: ObjectStore = {
      get: (key) => store.get(key),
      delete: (key) => store.delete(key),
      put: async (key, bytes, type) => {
        if (key.startsWith('results/') && fail) {
          fail = false;
          throw new Error('Injected outage');
        }
        await store.put(key, bytes, type);
      },
    };
    const adapter = new SimulatedProvider(flaky, 'sync');
    let calls = 0;
    const original = adapter.submit.bind(adapter);
    adapter.submit = async (r, c) => {
      calls++;
      return original(r, c);
    };
    const worker = isolated(adapter, randomUUID(), flaky).dispatch;
    const task = await job();
    const id = task.job.items[0]!.id;
    await worker.process(id);
    expect((await jobs.get(task.userId, task.job.id)).stage).toBe('materializing');
    await due(id);
    await worker.process(id);
    await worker.process(id);
    expect((await jobs.get(task.userId, task.job.id)).status).toBe('succeeded');
    expect(calls).toBe(1);
    expect(await wallet.balance(task.userId)).toMatchObject({ consumed: 30n, held: 0n });
  });
  it('late success records supplier cost without recharging a refunded item', async () => {
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish!: (r: SubmitResult) => void;
    let captured!: { request: NormalizedImageRequest; context: ProviderContext };
    const adapter = new SimulatedProvider(store, 'sync');
    adapter.submit = async (request, context) => {
      captured = { request, context };
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    const worker = isolated(adapter).dispatch;
    const task = await job();
    const id = task.job.items[0]!.id;
    const submitting = worker.process(id);
    await entered;
    await db.database.client.generationJob.update({
      where: { id: task.job.id },
      data: { deliveryDeadlineAt: new Date(0) },
    });
    await worker.process(id);
    finish(
      await adapter.query({
        providerRequestId: captured.request.attemptId,
        channelId: captured.context.channelId,
        credentialVersionRef: captured.context.credentialVersionRef,
      }),
    );
    await submitting;
    expect(await jobs.get(task.userId, task.job.id)).toMatchObject({
      status: 'failed',
      chargedCredits: 0,
      resultAssetIds: [],
    });
    expect(await wallet.balance(task.userId)).toMatchObject({ available: 1000n, consumed: 0n });
    expect(
      await db.database.client.providerUsageRecord.findFirst({
        where: { attempt: { itemId: id } },
      }),
    ).toMatchObject({ certainty: 'billable', actualCostMicros: 1200n });
  });
  it('shared project quota and budget are atomic across users and channel aliases', async () => {
    for (const [concurrency, dailyBudgetMicros] of [
      [1, 1_000_000n],
      [99, 1000n],
    ] as const) {
      const scope = randomUUID();
      const channels = [0, 1].map((index) => ({
        adapter: new SimulatedProvider(store, 'async'),
        profile: {
          ...SIMULATED_PROFILES[0]!,
          id: `${scope}-${index}`,
          quotaScope: scope,
          budgetScope: scope,
          concurrency,
          dailyBudgetMicros,
        },
      }));
      const worker = new DispatchService(
        db.database,
        wallet,
        store,
        new ProviderRegistry(store, channels),
      );
      const tasks = await Promise.all([job(), job()]);
      await Promise.all(tasks.map((t) => worker.process(t.job.items[0]!.id)));
      expect(await db.database.client.providerAttempt.count({ where: { quotaScope: scope } })).toBe(
        1,
      );
      expect(
        await db.database.client.providerQuota.findUnique({ where: { id: scope } }),
      ).toMatchObject({ inflight: 1 });
      expect(
        await db.database.client.providerBudget.findFirst({ where: { id: { startsWith: scope } } }),
      ).toMatchObject({ reservedMicros: 1000n, consumedMicros: 0n });
    }
  });
  it('independent project quotas do not block each other', async () => {
    const scope = randomUUID();
    const channels = [0, 1].map((index) => ({
      adapter: new SimulatedProvider(store, 'async'),
      profile: {
        ...SIMULATED_PROFILES[0]!,
        id: `${scope}-${index}`,
        quotaScope: `${scope}-${index}`,
        budgetScope: `${scope}-${index}`,
        concurrency: 1,
      },
    }));
    const worker = new DispatchService(
      db.database,
      wallet,
      store,
      new ProviderRegistry(store, channels),
    );
    const tasks = await Promise.all([job(), job()]);
    await Promise.all(tasks.map((task) => worker.process(task.job.items[0]!.id)));
    const attempts = await db.database.client.providerAttempt.findMany({
      where: { userId: { in: tasks.map((task) => task.userId) } },
    });
    expect(attempts).toHaveLength(2);
    expect(new Set(attempts.map((attempt) => attempt.quotaScope)).size).toBe(2);
  });
  it('confirmed cancellation frees execution quota even if its fee is unknown', async () => {
    const adapter = new SimulatedProvider(store, 'async');
    const custom: ProviderAdapter = {
      protocol: adapter.protocol,
      capabilities: () => adapter.capabilities(),
      validate: (r) => adapter.validate(r),
      submit: (r, c) => adapter.submit(r, c),
      query: (ref) => adapter.query(ref),
      cancel: async () => ({ kind: 'confirmed', billing: 'unknown' }),
    };
    const local = isolated(custom);
    const task = await job();
    const id = task.job.items[0]!.id;
    await local.dispatch.process(id);
    await jobs.cancel(task.userId, task.job.id);
    await due(id);
    await local.dispatch.process(id);
    expect((await jobs.get(task.userId, task.job.id)).status).toBe('cancelled');
    expect(
      await db.database.client.providerQuota.findUnique({
        where: { id: local.profile.quotaScope },
      }),
    ).toMatchObject({ inflight: 0, unknown: 0 });
    expect(
      await db.database.client.providerUsageRecord.findFirst({
        where: { attempt: { itemId: id } },
      }),
    ).toMatchObject({ certainty: 'unknown', actualCostMicros: null });
  });
  it('duplicate workers submit once, persist a private result, and consume once', async () => {
    const task = await job();
    const id = task.job.items[0]!.id;
    await Promise.all([dispatch.process(id), dispatch.process(id)]);
    // Default async simulation is queryable after a fresh registry/worker instance.
    await db.database.client.generationItem.update({
      where: { id },
      data: { nextRunAt: new Date(0) },
    });
    await new DispatchService(db.database, wallet, store, new ProviderRegistry(store)).process(id);
    const result = await jobs.get(task.userId, task.job.id);
    expect(result.status).toBe('succeeded');
    expect(result.chargedCredits).toBe(30);
    expect(await db.database.client.providerAttempt.count({ where: { itemId: id } })).toBe(1);
    const asset = await db.database.client.asset.findUniqueOrThrow({
      where: { id: result.resultAssetIds[0]! },
    });
    expect((await store.get(asset.objectKey)).byteLength).toBeGreaterThan(0);
    expect(await wallet.balance(task.userId)).toMatchObject({
      available: 970n,
      held: 0n,
      consumed: 30n,
    });
  });
  it('cannot attach a query response for another upstream request to this item', async () => {
    const adapter = new SimulatedProvider(store, 'async');
    const query = adapter.query.bind(adapter);
    adapter.query = (ref) => query({ ...ref, providerRequestId: 'wrong-upstream-request' });
    const worker = isolated(adapter).dispatch;
    const task = await job();
    const id = task.job.items[0]!.id;
    await worker.process(id);
    await due(id);
    await worker.process(id);
    expect(await jobs.get(task.userId, task.job.id)).toMatchObject({
      stage: 'unknown',
      chargedCredits: 0,
      resultAssetIds: [],
    });
  });
  it('cancelled queued items never reach a provider', async () => {
    const task = await job();
    await jobs.cancel(task.userId, task.job.id);
    await dispatch.process(task.job.items[0]!.id);
    expect(
      await db.database.client.providerAttempt.count({ where: { itemId: task.job.items[0]!.id } }),
    ).toBe(0);
  });
  it('expired submitting lease becomes unknown, never resubmitted; deadline releases only credits', async () => {
    const task = await job();
    const id = task.job.items[0]!.id;
    await dispatch.process(id);
    await db.database.client.generationItem.update({
      where: { id },
      data: { status: 'submitting', leaseUntil: new Date(0), nextRunAt: new Date(0) },
    });
    await db.database.client.providerAttempt.updateMany({
      where: { itemId: id },
      data: { status: 'submitting', providerRequestId: null, acceptance: 'unknown' },
    });
    await new RecoveryService(db.database, dispatch).scan();
    expect(
      (await db.database.client.generationItem.findUniqueOrThrow({ where: { id } })).status,
    ).toBe('unknown');
    await db.database.client.generationJob.update({
      where: { id: task.job.id },
      data: { deliveryDeadlineAt: new Date(0) },
    });
    await new RecoveryService(db.database, dispatch).scan();
    expect((await jobs.get(task.userId, task.job.id)).status).toBe('failed');
    expect(await wallet.balance(task.userId)).toMatchObject({ available: 1000n, held: 0n });
    expect(await db.database.client.providerAttempt.count({ where: { itemId: id } })).toBe(1);
    expect(
      await db.database.client.providerUsageRecord.findFirst({
        where: { attempt: { itemId: id } },
      }),
    ).toMatchObject({ certainty: 'unknown', actualCostMicros: null, simulated: true });
  });
});
