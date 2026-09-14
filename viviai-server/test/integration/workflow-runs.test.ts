import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';
import { createApp } from '../../src/main.js';
import { IdentityService } from '../../src/modules/identity/identity.service.js';
import { LocalObjectStore } from '../../src/modules/assets/local-object-store.js';
import { WalletService } from '../../src/modules/wallet/wallet.service.js';
import { ProviderRegistry } from '../../src/modules/providers/registry.js';
import { DispatchService } from '../../src/modules/generation/dispatch.service.js';
import { SettlementService } from '../../src/modules/generation/settlement.service.js';
import { BatchProjectionService } from '../../src/modules/workflow/batch-projection.service.js';

const origin = 'http://localhost:3000';

describe('workflow batch execution', () => {
  let db: TestDatabase;
  let app: INestApplication;
  let root: string;
  let store: LocalObjectStore;
  let wallet: WalletService;
  let settlement: SettlementService;

  beforeAll(async () => {
    db = await createTestDatabase();
    root = await mkdtemp(join(tmpdir(), 'viviai-workflow-run-test-'));
    store = new LocalObjectStore(root);
    wallet = new WalletService(db.database);
    settlement = new SettlementService(db.database, wallet, store);
    app = await createApp({ nodeEnv: 'test', databaseUrl: db.url, localStorageRoot: root });
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app?.close();
    await db?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function actor(credits = 1000n) {
    const id = randomUUID();
    await db.database.client.user.create({
      data: { id, email: `${id}@example.test`, username: id, passwordHash: 'unused' },
    });
    if (credits > 0n) {
      await db.database.transaction((tx) => wallet.grant(tx, id, 'test', credits, null));
    }
    return { id, cookie: `viviai_session=${await app.get(IdentityService).createSession(id, 1)}` };
  }

  const post = (cookie: string, path: string, body?: object, key?: string) =>
    request(app.getHttpServer())
      .post(`/api${path}`)
      .set('Origin', origin)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key ?? randomUUID())
      .send(body ?? {});
  const get = (cookie: string, path: string) =>
    request(app.getHttpServer()).get(`/api${path}`).set('Origin', origin).set('Cookie', cookie);

  /** A two-row, two-column workflow: four batch items at 30 credits each. */
  async function seededWorkflow(cookie: string) {
    const workflow = (
      await post(cookie, '/workflows', {
        name: 'Campaign A',
        columns: [
          { id: 'ref', name: '参考图', type: 'reference' },
          {
            id: 'gen',
            name: '主图',
            type: 'generation',
            prompt: 'A clean product photo',
            sourceColumnIds: [],
            modelId: 'simulation-image-v1',
            resolution: '1K',
            ratio: '1:1',
          },
          {
            id: 'poster',
            name: '海报',
            type: 'generation',
            prompt: 'A poster',
            sourceColumnIds: [],
            modelId: 'simulation-image-v1',
            resolution: '1K',
            ratio: '1:1',
          },
        ],
        rows: [
          { rowKey: 'row-1', cells: {} },
          { rowKey: 'row-2', cells: {} },
        ],
      })
    ).body.data;
    const quote = (
      await post(cookie, '/workflow-run-quotes', {
        workflowId: workflow.id,
        rowIds: ['row-1', 'row-2'],
      })
    ).body.data;
    return { workflow, quote };
  }

  const TERMINAL = ['succeeded', 'failed', 'cancelled'];
  const due = (id: string) =>
    db.database.client.generationItem.update({ where: { id }, data: { nextRunAt: new Date(0) } });
  /** Drives one generation item to a terminal state the way the worker would. */
  async function settle(itemId: string) {
    for (let pass = 0; pass < 6; pass += 1) {
      const item = await db.database.client.generationItem.findUniqueOrThrow({ where: { id: itemId } });
      if (TERMINAL.includes(item.status)) return item;
      await due(itemId);
      await new DispatchService(
        db.database,
        wallet,
        store,
        new ProviderRegistry(store),
      ).process(itemId);
    }
    throw new Error(`generation item ${itemId} never settled`);
  }

  async function jobItemIds(runId: string) {
    const items = await db.database.client.workflowRunItem.findMany({
      where: { runId },
      orderBy: [{ rowKey: 'asc' }, { columnKey: 'asc' }],
      include: { generationJob: { include: { items: true } } },
    });
    return items;
  }

  it('freezes credits for every item and links one job per run item', async () => {
    const user = await actor();
    const { quote } = await seededWorkflow(user.cookie);
    expect(quote).toMatchObject({ submittable: true, totalCredits: 120 });

    const response = await post(user.cookie, '/workflow-runs', { quoteId: quote.quoteId });
    expect(response.status).toBe(201);
    const run = response.body.data;
    expect(run).toMatchObject({
      status: 'queued',
      totalCount: 4,
      succeededCount: 0,
      failedCount: 0,
      cancelledCount: 0,
      estimatedCredits: 120,
      cancelRequested: false,
      retryOfRunId: null,
    });
    expect(run.childTaskIds).toHaveLength(4);
    expect(run.items).toHaveLength(4);

    expect(await db.database.client.workflowRunItem.count({ where: { runId: run.id } })).toBe(4);
    expect(await db.database.client.generationJob.count({ where: { userId: user.id } })).toBe(4);
    expect(await wallet.balance(user.id)).toMatchObject({ available: 880n, held: 120n });
    const aggregate = await db.database.client.workflowRunQuote.findUniqueOrThrow({
      where: { id: quote.quoteId },
    });
    expect(aggregate.consumedAt).not.toBeNull();
    expect(
      await db.database.client.generationQuote.count({
        where: { originType: 'workflow', consumedAt: null },
      }),
    ).toBe(0);
  });

  it('replays the same idempotency key without creating a second run', async () => {
    const user = await actor();
    const { quote } = await seededWorkflow(user.cookie);
    const key = randomUUID();
    const first = await post(user.cookie, '/workflow-runs', { quoteId: quote.quoteId }, key);
    const second = await post(user.cookie, '/workflow-runs', { quoteId: quote.quoteId }, key);
    expect(second.status).toBe(201);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(await db.database.client.workflowRun.count({ where: { userId: user.id } })).toBe(1);
    expect(await wallet.balance(user.id)).toMatchObject({ available: 880n, held: 120n });
  });

  it('refuses a missing, used or foreign aggregate quote', async () => {
    const user = await actor();
    const other = await actor();
    const { quote } = await seededWorkflow(user.cookie);
    await post(user.cookie, '/workflow-runs', { quoteId: quote.quoteId });

    expect((await post(user.cookie, '/workflow-runs', { quoteId: quote.quoteId })).status).toBe(409);
    expect((await post(user.cookie, '/workflow-runs', { quoteId: randomUUID() })).status).toBe(404);
    expect((await post(other.cookie, '/workflow-runs', { quoteId: quote.quoteId })).status).toBe(404);
    expect((await post(user.cookie, '/workflow-runs', {})).status).toBe(400);
    expect((await post(user.cookie, '/workflow-runs', { quoteId: 'nope' })).status).toBe(400);
  });

  it('rejects an expired aggregate quote', async () => {
    const user = await actor();
    const { quote } = await seededWorkflow(user.cookie);
    await db.database.client.workflowRunQuote.update({
      where: { id: quote.quoteId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const response = await post(user.cookie, '/workflow-runs', { quoteId: quote.quoteId });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('QUOTE_EXPIRED');
  });

  it('rolls the entire batch back when the balance is short', async () => {
    const user = await actor(0n);
    const { quote } = await seededWorkflow(user.cookie);
    const response = await post(user.cookie, '/workflow-runs', { quoteId: quote.quoteId });
    expect(response.status).toBe(402);
    expect(response.body.code).toBe('INSUFFICIENT_CREDITS');
    expect(await db.database.client.workflowRun.count({ where: { userId: user.id } })).toBe(0);
    expect(await db.database.client.workflowRunItem.count({ where: { run: { userId: user.id } } })).toBe(0);
    expect(await db.database.client.generationJob.count({ where: { userId: user.id } })).toBe(0);
    expect(await wallet.balance(user.id)).toMatchObject({ available: 0n, held: 0n });
    expect(
      (await db.database.client.workflowRunQuote.findUniqueOrThrow({ where: { id: quote.quoteId } }))
        .consumedAt,
    ).toBeNull();
  });

  it('cancels queued items, releases their credits and reports a cancelled run', async () => {
    const user = await actor();
    const { quote } = await seededWorkflow(user.cookie);
    const run = (await post(user.cookie, '/workflow-runs', { quoteId: quote.quoteId })).body.data;

    const response = await post(user.cookie, `/workflow-runs/${run.id}/cancel`);
    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      status: 'cancelled',
      cancelRequested: true,
      cancelledCount: 4,
      succeededCount: 0,
      failedCount: 0,
    });
    expect(await wallet.balance(user.id)).toMatchObject({ available: 1000n, held: 0n });
    expect(
      await db.database.client.generationItem.count({
        where: { jobId: { in: run.childTaskIds }, status: 'cancelled' },
      }),
    ).toBe(4);
  });

  it('aggregates partial execution and releases credits only for failed items', async () => {
    const user = await actor();
    const { quote } = await seededWorkflow(user.cookie);
    const run = (await post(user.cookie, '/workflow-runs', { quoteId: quote.quoteId })).body.data;
    const items = await jobItemIds(run.id);
    expect(items).toHaveLength(4);

    // Finish two items through the worker and fail the other two.
    await settle(items[0]!.generationJob.items[0]!.id);
    await settle(items[1]!.generationJob.items[0]!.id);
    for (const item of [items[2]!, items[3]!]) {
      await db.database.transaction((tx) =>
        settlement.fail(tx, item.generationJob.items[0]!.id, 'PROVIDER_ERROR'),
      );
    }

    const detail = await get(user.cookie, `/workflow-runs/${run.id}`);
    expect(detail.body.data).toMatchObject({
      status: 'partial',
      totalCount: 4,
      succeededCount: 2,
      failedCount: 2,
      cancelledCount: 0,
    });
    expect(await wallet.balance(user.id)).toMatchObject({ available: 940n, held: 0n, consumed: 60n });
  });

  it('retries only failed items into a new run that never reuses the consumed quote', async () => {
    const user = await actor();
    const { quote } = await seededWorkflow(user.cookie);
    const run = (await post(user.cookie, '/workflow-runs', { quoteId: quote.quoteId })).body.data;
    const items = await jobItemIds(run.id);
    for (const item of items.slice(0, 2)) {
      await db.database.transaction((tx) =>
        settlement.fail(tx, item.generationJob.items[0]!.id, 'PROVIDER_ERROR'),
      );
    }
    for (const item of items.slice(2)) {
      await settle(item.generationJob.items[0]!.id);
    }

    const retryQuote = (
      await post(user.cookie, '/workflow-run-quotes', { retryRunId: run.id })
    ).body.data;
    expect(retryQuote).toMatchObject({ submittable: true, totalCredits: 60 });
    expect(retryQuote.items).toHaveLength(2);
    expect(retryQuote.items.map((item: { rowKey: string }) => item.rowKey)).toEqual(
      items.slice(0, 2).map((item) => item.rowKey),
    );

    const response = await post(user.cookie, `/workflow-runs/${run.id}/retry-failed`, {
      quoteId: retryQuote.quoteId,
    });
    expect(response.status).toBe(201);
    const retry = response.body.data;
    expect(retry).toMatchObject({ retryOfRunId: run.id, totalCount: 2, status: 'queued' });
    expect(retry.id).not.toBe(run.id);

    const original = await get(user.cookie, `/workflow-runs/${run.id}`);
    expect(original.body.data).toMatchObject({ status: 'partial', totalCount: 4, succeededCount: 2 });
    expect(await wallet.balance(user.id)).toMatchObject({ available: 880n, held: 60n, consumed: 60n });
  });

  it('lists runs and exposes the same record as a batch', async () => {
    const user = await actor();
    const { quote } = await seededWorkflow(user.cookie);
    const run = (await post(user.cookie, '/workflow-runs', { quoteId: quote.quoteId })).body.data;

    const runs = await get(user.cookie, '/workflow-runs');
    expect(runs.status).toBe(200);
    expect(runs.body.data).toHaveLength(1);
    expect(runs.body.data[0]).toMatchObject({ id: run.id, workflowName: 'Campaign A' });

    const batches = await get(user.cookie, '/batches');
    expect(batches.body.data).toHaveLength(1);
    expect(batches.body.data[0].id).toBe(run.id);

    const batch = await get(user.cookie, `/batches/${run.id}`);
    expect(batch.status).toBe(200);
    expect(batch.body.data).toMatchObject({ id: run.id, totalCount: 4 });
  });

  it('scopes runs to their owner', async () => {
    const user = await actor();
    const other = await actor();
    const { quote } = await seededWorkflow(user.cookie);
    const run = (await post(user.cookie, '/workflow-runs', { quoteId: quote.quoteId })).body.data;

    expect((await get(other.cookie, `/workflow-runs/${run.id}`)).status).toBe(404);
    expect((await get(other.cookie, `/batches/${run.id}`)).status).toBe(404);
    expect((await post(other.cookie, `/workflow-runs/${run.id}/cancel`)).status).toBe(404);
    expect((await get(other.cookie, '/workflow-runs')).body.data).toEqual([]);
    expect((await get(user.cookie, '/workflow-runs/not-a-uuid')).status).toBe(404);
    expect((await get(user.cookie, `/workflow-run-quotes`)).status).toBe(404);
  });

  it('reconciles run counts from linked jobs rather than trusting stored counters', async () => {
    const user = await actor();
    const { quote } = await seededWorkflow(user.cookie);
    const run = (await post(user.cookie, '/workflow-runs', { quoteId: quote.quoteId })).body.data;
    await db.database.client.workflowRun.update({
      where: { id: run.id },
      data: { succeededCount: 99, failedCount: 99 },
    });
    const projection = new BatchProjectionService(db.database);
    await db.database.transaction((tx) => projection.reconcile(tx, run.id));
    const stored = await db.database.client.workflowRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(stored).toMatchObject({ succeededCount: 0, failedCount: 0, totalCount: 4, status: 'queued' });
  });
});
