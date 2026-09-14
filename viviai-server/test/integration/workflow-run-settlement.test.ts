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
import { RecoveryService } from '../../src/modules/generation/recovery.service.js';

const origin = 'http://localhost:3000';
const TERMINAL = ['succeeded', 'failed', 'cancelled'];

describe('workflow batch settlement', () => {
  let db: TestDatabase;
  let app: INestApplication;
  let root: string;
  let store: LocalObjectStore;
  let wallet: WalletService;
  let dispatch: DispatchService;
  let settlement: SettlementService;
  let recovery: RecoveryService;

  beforeAll(async () => {
    db = await createTestDatabase();
    root = await mkdtemp(join(tmpdir(), 'viviai-workflow-settle-test-'));
    store = new LocalObjectStore(root);
    wallet = new WalletService(db.database);
    settlement = new SettlementService(db.database, wallet, store);
    dispatch = new DispatchService(db.database, wallet, store, new ProviderRegistry(store));
    recovery = new RecoveryService(db.database, dispatch);
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
    await db.database.transaction((tx) => wallet.grant(tx, id, 'test', credits, null));
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

  const due = (id: string) =>
    db.database.client.generationItem.update({ where: { id }, data: { nextRunAt: new Date(0) } });

  /** Drives one generation item to a terminal state the way the worker would. */
  async function settle(itemId: string) {
    for (let pass = 0; pass < 6; pass += 1) {
      const item = await db.database.client.generationItem.findUniqueOrThrow({ where: { id: itemId } });
      if (TERMINAL.includes(item.status)) return item;
      await due(itemId);
      await new DispatchService(db.database, wallet, store, new ProviderRegistry(store)).process(itemId);
    }
    throw new Error(`generation item ${itemId} never settled`);
  }

  async function submittedRun(cookie: string, rows = ['row-1']) {
    const workflow = (
      await post(cookie, '/workflows', {
        name: 'Settlement batch',
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
        ],
        rows: rows.map((rowKey) => ({ rowKey, cells: {} })),
      })
    ).body.data;
    const quote = (
      await post(cookie, '/workflow-run-quotes', { workflowId: workflow.id, rowIds: rows })
    ).body.data;
    const run = (await post(cookie, '/workflow-runs', { quoteId: quote.quoteId })).body.data;
    const items = await db.database.client.workflowRunItem.findMany({
      where: { runId: run.id },
      orderBy: { rowKey: 'asc' },
      include: { generationJob: { include: { items: true } } },
    });
    return { workflow, quote, run, items };
  }

  it('charges settled items and releases the credits of failed items', async () => {
    const user = await actor();
    const { run, items } = await submittedRun(user.cookie, ['row-1', 'row-2']);
    expect(items).toHaveLength(2);

    await settle(items[0]!.generationJob.items[0]!.id);
    await db.database.transaction((tx) =>
      settlement.fail(tx, items[1]!.generationJob.items[0]!.id, 'PROVIDER_ERROR'),
    );

    expect(await wallet.balance(user.id)).toMatchObject({ available: 970n, held: 0n, consumed: 30n });
    const projection = await get(user.cookie, `/workflow-runs/${run.id}`);
    expect(projection.body.data).toMatchObject({
      status: 'partial',
      succeededCount: 1,
      failedCount: 1,
      chargedCredits: 30,
      estimatedCredits: 60,
    });
    const stored = await db.database.client.workflowRunItem.findMany({
      where: { runId: run.id },
      orderBy: { rowKey: 'asc' },
    });
    expect(stored.map((item) => item.status)).toEqual(['succeeded', 'failed']);
    expect(stored[1]!.errorCode).toBe('PROVIDER_ERROR');
  });

  it('charges nothing when every item fails', async () => {
    const user = await actor();
    const { run, items } = await submittedRun(user.cookie, ['row-1', 'row-2']);
    for (const item of items) {
      await db.database.transaction((tx) =>
        settlement.fail(tx, item.generationJob.items[0]!.id, 'PROVIDER_ERROR'),
      );
    }
    expect(await wallet.balance(user.id)).toMatchObject({ available: 1000n, held: 0n, consumed: 0n });
    const detail = await get(user.cookie, `/workflow-runs/${run.id}`);
    expect(detail.body.data).toMatchObject({ status: 'failed', failedCount: 2, succeededCount: 0 });
  });

  it('releases queued items when a run is cancelled mid-flight', async () => {
    const user = await actor();
    const { run, items } = await submittedRun(user.cookie, ['row-1', 'row-2']);
    await settle(items[0]!.generationJob.items[0]!.id);

    const response = await post(user.cookie, `/workflow-runs/${run.id}/cancel`);
    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      cancelRequested: true,
      succeededCount: 1,
      cancelledCount: 1,
      status: 'partial',
    });
    expect(await wallet.balance(user.id)).toMatchObject({ available: 970n, held: 0n, consumed: 30n });
  });

  it('settles a terminal event once even when the worker event is delivered twice', async () => {
    const user = await actor();
    const { run, items } = await submittedRun(user.cookie, ['row-1']);
    const itemId = items[0]!.generationJob.items[0]!.id;
    await settle(itemId);
    await settle(itemId);

    expect(await wallet.balance(user.id)).toMatchObject({ available: 970n, consumed: 30n });
    const stored = await db.database.client.workflowRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(stored).toMatchObject({ status: 'succeeded', succeededCount: 1, totalCount: 1 });
  });

  it('projects a stale queued run through repeated recovery passes without changing credits', async () => {
    const user = await actor();
    const { run, items } = await submittedRun(user.cookie, ['row-1']);
    const itemId = items[0]!.generationJob.items[0]!.id;

    await due(itemId);
    await recovery.scan(new Date());
    await settle(itemId);
    await recovery.scan(new Date());
    await recovery.scan(new Date());

    const detail = await get(user.cookie, `/workflow-runs/${run.id}`);
    expect(detail.body.data).toMatchObject({ status: 'succeeded', succeededCount: 1, failedCount: 0 });
    expect(await wallet.balance(user.id)).toMatchObject({ available: 970n, held: 0n, consumed: 30n });
  });

  it('keeps a run processing while any linked item is still outstanding', async () => {
    const user = await actor();
    const { run, items } = await submittedRun(user.cookie, ['row-1', 'row-2']);
    await settle(items[0]!.generationJob.items[0]!.id);
    await dispatch.process(items[1]!.generationJob.items[0]!.id);

    const detail = await get(user.cookie, `/workflow-runs/${run.id}`);
    expect(detail.body.data).toMatchObject({ status: 'processing', succeededCount: 1, totalCount: 2 });
    // One item charged, the outstanding one still frozen.
    expect(await wallet.balance(user.id)).toMatchObject({
      available: 940n,
      held: 30n,
      consumed: 30n,
    });

    await settle(items[1]!.generationJob.items[0]!.id);
    const settled = await get(user.cookie, `/workflow-runs/${run.id}`);
    expect(settled.body.data).toMatchObject({
      status: 'succeeded',
      succeededCount: 2,
      chargedCredits: 60,
    });
  });
});
