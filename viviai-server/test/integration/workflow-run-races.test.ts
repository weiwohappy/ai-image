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
import { BatchProjectionService } from '../../src/modules/workflow/batch-projection.service.js';
import { SettlementService } from '../../src/modules/generation/settlement.service.js';

const origin = 'http://localhost:3000';

describe('workflow batch races', () => {
  let db: TestDatabase;
  let app: INestApplication;
  let root: string;
  let wallet: WalletService;
  let projection: BatchProjectionService;
  let settlement: SettlementService;

  beforeAll(async () => {
    db = await createTestDatabase();
    root = await mkdtemp(join(tmpdir(), 'viviai-workflow-race-test-'));
    wallet = new WalletService(db.database);
    projection = new BatchProjectionService(db.database);
    settlement = new SettlementService(db.database, wallet, new LocalObjectStore(root));
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
    if (credits > 0n) await db.database.transaction((tx) => wallet.grant(tx, id, 'test', credits, null));
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

  async function seededWorkflow(cookie: string, rows = ['row-1', 'row-2']) {
    const workflow = (
      await post(cookie, '/workflows', {
        name: 'Race batch',
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
    return { workflow, quote };
  }

  it('lets exactly one of two concurrent submissions consume the aggregate quote', async () => {
    const user = await actor();
    const { quote } = await seededWorkflow(user.cookie);

    const responses = await Promise.all([
      post(user.cookie, '/workflow-runs', { quoteId: quote.quoteId }),
      post(user.cookie, '/workflow-runs', { quoteId: quote.quoteId }, undefined),
    ]);
    const created = responses.filter((response) => response.status === 201);
    const refused = responses.filter((response) => response.status >= 400);
    expect(created).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect([404, 409]).toContain(refused[0]!.status);
    expect(await db.database.client.workflowRun.count({ where: { userId: user.id } })).toBe(1);
    expect(await wallet.balance(user.id)).toMatchObject({ available: 940n, held: 60n });
  });

  it('replays one concurrent duplicate key into a single run', async () => {
    const user = await actor();
    const { quote } = await seededWorkflow(user.cookie);
    const key = randomUUID();

    const responses = await Promise.all([
      post(user.cookie, '/workflow-runs', { quoteId: quote.quoteId }, key),
      post(user.cookie, '/workflow-runs', { quoteId: quote.quoteId }, key),
    ]);
    const ids = new Set(responses.map((response) => response.body.data?.id));
    expect(ids.size).toBe(1);
    expect(await db.database.client.workflowRun.count({ where: { userId: user.id } })).toBe(1);
    expect(await wallet.balance(user.id)).toMatchObject({ available: 940n, held: 60n });
  });

  it('does not double count when reconcile runs repeatedly', async () => {
    const user = await actor();
    const { quote } = await seededWorkflow(user.cookie);
    const run = (await post(user.cookie, '/workflow-runs', { quoteId: quote.quoteId })).body.data;

    const items = await db.database.client.workflowRunItem.findMany({ where: { runId: run.id } });
    await db.database.client.generationItem.updateMany({
      where: { jobId: { in: items.map((item) => item.generationJobId) } },
      data: { status: 'succeeded' },
    });
    for (let pass = 0; pass < 3; pass += 1) {
      await db.database.transaction((tx) => projection.reconcile(tx, run.id));
    }
    const stored = await db.database.client.workflowRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(stored).toMatchObject({
      status: 'succeeded',
      totalCount: 2,
      succeededCount: 2,
      failedCount: 0,
      cancelledCount: 0,
    });
    expect(
      await db.database.client.workflowRunItem.count({ where: { runId: run.id, status: 'succeeded' } }),
    ).toBe(2);
  });

  it('keeps a cancelled run cancelled when a late worker event arrives', async () => {
    const user = await actor();
    const { quote } = await seededWorkflow(user.cookie);
    const run = (await post(user.cookie, '/workflow-runs', { quoteId: quote.quoteId })).body.data;
    await post(user.cookie, `/workflow-runs/${run.id}/cancel`);

    await db.database.client.workflowRunItem.updateMany({
      where: { runId: run.id },
      data: { status: 'succeeded' },
    });
    await db.database.transaction((tx) => projection.reconcile(tx, run.id));

    const stored = await db.database.client.workflowRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(stored).toMatchObject({ status: 'cancelled', cancelRequested: true });
    expect(stored.succeededCount).toBe(0);
  });

  it('refuses cancelling the same run twice without releasing credits twice', async () => {
    const user = await actor();
    const { quote } = await seededWorkflow(user.cookie);
    const run = (await post(user.cookie, '/workflow-runs', { quoteId: quote.quoteId })).body.data;

    await post(user.cookie, `/workflow-runs/${run.id}/cancel`);
    const second = await post(user.cookie, `/workflow-runs/${run.id}/cancel`);
    expect([201, 409]).toContain(second.status);
    expect(await wallet.balance(user.id)).toMatchObject({ available: 1000n, held: 0n });
  });

  it('keeps concurrent retry submissions from consuming the retry quote twice', async () => {
    const user = await actor();
    const { quote } = await seededWorkflow(user.cookie);
    const run = (await post(user.cookie, '/workflow-runs', { quoteId: quote.quoteId })).body.data;
    const items = await db.database.client.workflowRunItem.findMany({
      where: { runId: run.id },
      include: { generationJob: { include: { items: true } } },
    });
    for (const item of items)
      await db.database.transaction((tx) =>
        settlement.fail(tx, item.generationJob.items[0]!.id, 'PROVIDER_ERROR'),
      );

    const retryQuote = (await post(user.cookie, '/workflow-run-quotes', { retryRunId: run.id })).body.data;
    expect(retryQuote.submittable).toBe(true);

    const responses = await Promise.all([
      post(user.cookie, `/workflow-runs/${run.id}/retry-failed`, { quoteId: retryQuote.quoteId }),
      post(user.cookie, `/workflow-runs/${run.id}/retry-failed`, { quoteId: retryQuote.quoteId }),
    ]);
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(await db.database.client.workflowRun.count({ where: { retryOfRunId: run.id } })).toBe(1);
    expect(await wallet.balance(user.id)).toMatchObject({ available: 940n, held: 60n });
  });

  it('rejects a retry quote that has no failed items left to run', async () => {
    const user = await actor();
    const { quote } = await seededWorkflow(user.cookie);
    const run = (await post(user.cookie, '/workflow-runs', { quoteId: quote.quoteId })).body.data;

    // Nothing can be retried until the run has settled.
    expect((await post(user.cookie, '/workflow-run-quotes', { retryRunId: run.id })).status).toBe(409);

    const items = await db.database.client.workflowRunItem.findMany({ where: { runId: run.id } });
    await db.database.client.generationItem.updateMany({
      where: { jobId: { in: items.map((item) => item.generationJobId) } },
      data: { status: 'succeeded' },
    });
    await db.database.transaction((tx) => projection.reconcile(tx, run.id));

    const response = await post(user.cookie, '/workflow-run-quotes', { retryRunId: run.id });
    expect([200, 201]).toContain(response.status);
    expect(response.body.data).toMatchObject({ submittable: false, quoteId: null, totalCredits: 0 });
    expect(response.body.data.items).toEqual([]);
  });

  it('scopes retry quoting to the run owner', async () => {
    const user = await actor();
    const other = await actor();
    const { quote } = await seededWorkflow(user.cookie);
    const run = (await post(user.cookie, '/workflow-runs', { quoteId: quote.quoteId })).body.data;
    expect((await post(other.cookie, '/workflow-run-quotes', { retryRunId: run.id })).status).toBe(404);
    expect((await post(other.cookie, `/workflow-runs/${run.id}/retry-failed`, { quoteId: quote.quoteId })).status).toBe(404);
    expect((await get(other.cookie, '/batches')).body.data).toEqual([]);
  });

  it('reports a run whose items reference another run quote as not found', async () => {
    const user = await actor();
    const { quote } = await seededWorkflow(user.cookie);
    const run = (await post(user.cookie, '/workflow-runs', { quoteId: quote.quoteId })).body.data;
    const response = await post(user.cookie, `/workflow-runs/${run.id}/retry-failed`, {
      quoteId: randomUUID(),
    });
    expect(response.status).toBe(404);
  });
});
