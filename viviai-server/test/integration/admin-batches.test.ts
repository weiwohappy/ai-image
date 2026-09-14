import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalObjectStore } from '../../src/modules/assets/local-object-store.js';
import { SettlementService } from '../../src/modules/generation/settlement.service.js';
import { IdentityService } from '../../src/modules/identity/identity.service.js';
import { WalletService } from '../../src/modules/wallet/wallet.service.js';
import { adminApp, adminOrigin, fixtureAdmin } from '../helpers/admin.js';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';

const userOrigin = 'http://localhost:3000';
const reason = 'Operational batch handling approved for integration test';
/** Distinctive strings that must never reach an administrator response. */
const promptSecret = 'private-prompt-7f3a';
const referenceSecret = 'private-reference-9c1d';

describe('admin workflow batch reads and batch operations', () => {
  let db: TestDatabase;
  let app: Awaited<ReturnType<typeof adminApp>>;
  let store: LocalObjectStore;
  let wallet: WalletService;
  let settlement: SettlementService;
  let root: string;
  let superAdmin: Awaited<ReturnType<typeof fixtureAdmin>>;
  let support: Awaited<ReturnType<typeof fixtureAdmin>>;
  let operator: Awaited<ReturnType<typeof fixtureAdmin>>;
  let outsider: Awaited<ReturnType<typeof fixtureAdmin>>;

  const call = (
    method: 'get' | 'post',
    cookie: string,
    path: string,
    input: Record<string, unknown> = {},
    key = randomUUID(),
  ) => {
    const pending = request(app.getHttpServer())
      [method](`/api/admin${path}`)
      .set('Cookie', cookie)
      .set('Origin', adminOrigin)
      .set('Idempotency-Key', key);
    return method === 'get' ? pending.query(input) : pending.send(input);
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    root = await mkdtemp(join(tmpdir(), 'viviai-admin-batch-test-'));
    store = new LocalObjectStore(root);
    wallet = new WalletService(db.database);
    settlement = new SettlementService(db.database, wallet, store);
    app = await adminApp(db, { nodeEnv: 'development', host: '127.0.0.1' });
    superAdmin = await fixtureAdmin(db, ['super_admin']);
    support = await fixtureAdmin(db, ['support']);
    operator = await fixtureAdmin(db, ['model_operator']);
    outsider = await fixtureAdmin(db, ['content_operator']);
  });

  afterAll(async () => {
    await app?.close();
    await db?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
  });

  /** A customer with a funded wallet and a browser session. */
  async function signedInCustomer(credits = 1000n) {
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
      .set('Origin', userOrigin)
      .set('Cookie', cookie)
      .set('Idempotency-Key', key ?? randomUUID())
      .send(body ?? {});

  /** Two rows by one generation column: a two item batch at 30 credits each. */
  async function seededBatch(cookie: string) {
    const workflow = (
      await post(cookie, '/workflows', {
        name: 'Campaign redaction check',
        columns: [
          { id: 'ref', name: '参考图', type: 'reference' },
          {
            id: 'gen',
            name: '主图',
            type: 'generation',
            prompt: promptSecret,
            sourceColumnIds: [],
            modelId: 'simulation-image-v1',
            resolution: '1K',
            ratio: '1:1',
          },
        ],
        rows: [
          { rowKey: 'row-1', cells: { ref: referenceSecret } },
          { rowKey: 'row-2', cells: { ref: referenceSecret } },
        ],
      })
    ).body.data;
    const quote = (
      await post(cookie, '/workflow-run-quotes', {
        workflowId: workflow.id,
        rowIds: ['row-1', 'row-2'],
      })
    ).body.data;
    const run = (await post(cookie, '/workflow-runs', { quoteId: quote.quoteId })).body.data;
    return { workflow, run };
  }

  async function runItems(runId: string) {
    return db.database.client.workflowRunItem.findMany({
      where: { runId },
      orderBy: [{ rowKey: 'asc' }, { columnKey: 'asc' }],
      include: { generationJob: { include: { items: true } } },
    });
  }

  const fail = (itemId: string, code: string) =>
    db.database.transaction((tx) => settlement.fail(tx, itemId, code));

  const TERMINAL = ['succeeded', 'failed', 'cancelled'];
  async function settle(itemId: string) {
    const { DispatchService } = await import('../../src/modules/generation/dispatch.service.js');
    const { ProviderRegistry } = await import('../../src/modules/providers/registry.js');
    for (let pass = 0; pass < 6; pass += 1) {
      const item = await db.database.client.generationItem.findUniqueOrThrow({
        where: { id: itemId },
      });
      if (TERMINAL.includes(item.status)) return;
      await db.database.client.generationItem.update({
        where: { id: itemId },
        data: { nextRunAt: new Date(0) },
      });
      await new DispatchService(db.database, wallet, store, new ProviderRegistry(store)).process(
        itemId,
      );
    }
    throw new Error(`generation item ${itemId} never settled`);
  }

  const storedRun = (runId: string) =>
    db.database.client.workflowRun.findUniqueOrThrow({ where: { id: runId } });

  it('separates task read from task manage permissions', async () => {
    const customer = await signedInCustomer();
    const { workflow, run } = await seededBatch(customer.cookie);

    // A read-only role sees both lists.
    expect((await call('get', support.cookie, '/workflows')).status).toBe(200);
    expect((await call('get', support.cookie, '/batches')).status).toBe(200);
    expect((await call('get', support.cookie, `/batches/${run.id}`)).status).toBe(200);
    expect((await call('get', support.cookie, `/workflows/${workflow.id}`)).status).toBe(200);
    // …but cannot dispose of a batch.
    const denied = await call('post', support.cookie, `/batches/${run.id}/cancel`, { reason });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('ADMIN_FORBIDDEN');

    // A role without the task read permissions is refused entirely.
    expect((await call('get', outsider.cookie, '/workflows')).status).toBe(403);
    expect((await call('get', outsider.cookie, '/batches')).status).toBe(403);
    expect((await call('get', outsider.cookie, `/batches/${run.id}`)).status).toBe(403);

    // The super administrator holds the whole family.
    expect((await call('get', superAdmin.cookie, '/workflows')).status).toBe(200);
    expect((await call('get', superAdmin.cookie, '/batches')).status).toBe(200);
  });

  it('redacts prompts, cell contents and asset references from every read', async () => {
    const customer = await signedInCustomer();
    const { workflow, run } = await seededBatch(customer.cookie);

    const list = await call('get', superAdmin.cookie, '/workflows');
    expect(list.body.data.rows[0]).toMatchObject({
      id: workflow.id,
      name: 'Campaign redaction check',
      version: 1,
      columnCount: 2,
      rowCount: 2,
      generationColumnCount: 1,
      status: 'active',
    });
    const workflowDetail = await call('get', superAdmin.cookie, `/workflows/${workflow.id}`);
    expect(workflowDetail.body.data.fields.map((field: { label: string }) => field.label)).toEqual(
      expect.arrayContaining(['名称', '版本', '列数', '生成列', '行数']),
    );
    expect(workflowDetail.body.data.tables[0].rows).toEqual([
      { id: 'ref', name: '参考图', type: 'reference', modelId: null },
      { id: 'gen', name: '主图', type: 'generation', modelId: 'simulation-image-v1' },
    ]);

    const batches = await call('get', superAdmin.cookie, '/batches');
    expect(batches.body.data.rows[0]).toMatchObject({
      id: run.id,
      userId: customer.id,
      status: 'queued',
      totalCount: 2,
      estimatedCredits: 60,
      chargedCredits: 0,
    });

    const detail = await call('get', superAdmin.cookie, `/batches/${run.id}`);
    expect(detail.body.data.fields.map((field: { label: string }) => field.label)).toContain(
      '批次状态',
    );
    const items = detail.body.data.tables.find(
      (entry: { title: string }) => entry.title === '批次明细',
    );
    expect(items.rows).toHaveLength(2);
    expect(items.rows[0]).toMatchObject({ rowKey: 'row-1', columnKey: 'gen', status: 'queued' });
    // The item row carries no generation job, asset or prompt reference.
    expect(Object.keys(items.rows[0]).sort()).toEqual([
      'columnKey',
      'columnName',
      'errorCode',
      'id',
      'retryable',
      'rowKey',
      'status',
    ]);

    for (const response of [list, workflowDetail, batches, detail]) {
      const body = JSON.stringify(response.body);
      expect(body).not.toContain(promptSecret);
      expect(body).not.toContain(referenceSecret);
    }
  });

  it('offers cancel only for a queued batch and retry only for retryable failures', async () => {
    const customer = await signedInCustomer();
    const { run } = await seededBatch(customer.cookie);
    const items = await runItems(run.id);
    const actions = async (cookie = superAdmin.cookie) =>
      (await call('get', cookie, `/batches/${run.id}`)).body.data.actions;

    // Nothing has started: cancellation is offered, a retry has nothing settled to repeat.
    expect(await actions()).toEqual([
      { action: 'cancel', allowed: true, reasonCode: null },
      { action: 'retryFailed', allowed: false, reasonCode: 'BATCH_NOT_SETTLED' },
    ]);

    // One item settles while the other is still queued, so the batch is running.
    await settle(items[0]!.generationJob.items[0]!.id);
    expect(await actions()).toEqual([
      { action: 'cancel', allowed: false, reasonCode: 'BATCH_NOT_QUEUED' },
      { action: 'retryFailed', allowed: false, reasonCode: 'BATCH_NOT_SETTLED' },
    ]);

    // The read-only role is told why it cannot act, without a write attempt.
    expect(await actions(support.cookie)).toEqual([
      { action: 'cancel', allowed: false, reasonCode: 'ADMIN_FORBIDDEN' },
      { action: 'retryFailed', allowed: false, reasonCode: 'ADMIN_FORBIDDEN' },
    ]);
  });

  it('distinguishes a settled batch with nothing to retry from one worth repeating', async () => {
    const customer = await signedInCustomer();
    const { run } = await seededBatch(customer.cookie);
    const items = await runItems(run.id);
    const actions = async () =>
      (await call('get', superAdmin.cookie, `/batches/${run.id}`)).body.data.actions;

    // A permanent provider rejection is not a system failure, so it is never retried.
    for (const item of items) await fail(item.generationJob.items[0]!.id, 'MODEL_UNAVAILABLE');
    expect(await actions()).toEqual([
      { action: 'cancel', allowed: false, reasonCode: 'BATCH_NOT_QUEUED' },
      { action: 'retryFailed', allowed: false, reasonCode: 'NO_RETRYABLE_FAILURES' },
    ]);

    // A transient failure on a settled batch is exactly what a retry is for.
    const retryable = await signedInCustomer();
    const second = await seededBatch(retryable.cookie);
    const [kept, transient] = await runItems(second.run.id);
    await settle(kept!.generationJob.items[0]!.id);
    await fail(transient!.generationJob.items[0]!.id, 'PROVIDER_ERROR');
    expect(
      (await call('get', superAdmin.cookie, `/batches/${second.run.id}`)).body.data.actions,
    ).toEqual([
      { action: 'cancel', allowed: false, reasonCode: 'BATCH_NOT_QUEUED' },
      { action: 'retryFailed', allowed: true, reasonCode: null },
    ]);
  });

  it('requires a operational reason and a well formed idempotency key', async () => {
    const customer = await signedInCustomer();
    const { run } = await seededBatch(customer.cookie);

    for (const body of [{}, { reason: 'oops' }, { reason: '    ' }, { reason: reason.padEnd(501, '!') }]) {
      const response = await call('post', superAdmin.cookie, `/batches/${run.id}/cancel`, body);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('ADMIN_INVALID_INPUT');
    }
    expect(
      (await call('post', superAdmin.cookie, `/batches/${run.id}/cancel`, { reason }, 'not-a-uuid'))
        .status,
    ).toBe(400);
    expect(
      (await call('post', superAdmin.cookie, `/batches/${run.id}/cancel`, { reason, extra: 1 }))
        .status,
    ).toBe(400);
    // Nothing was cancelled by the rejected attempts.
    expect((await storedRun(run.id)).cancelRequested).toBe(false);
  });

  it('cancels a queued batch, releases its credits and records a sanitized audit event', async () => {
    const customer = await signedInCustomer();
    const { run } = await seededBatch(customer.cookie);

    const response = await call('post', superAdmin.cookie, `/batches/${run.id}/cancel`, { reason });
    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      resourceId: run.id,
      status: 'cancelled',
      cancelledCount: 2,
    });
    expect(await wallet.balance(customer.id)).toMatchObject({ available: 1000n, held: 0n });

    const events = await db.database.client.adminAuditEvent.findMany({
      where: { action: 'batches.cancel', resourceId: run.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      accountId: superAdmin.account.id,
      resourceId: run.id,
      outcome: 'allowed',
      metadata: { beforeStatus: 'queued', afterStatus: 'cancelled', itemCount: 2 },
    });
    expect(events[0]!.reasonDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(events[0])).not.toContain(reason);
    expect(JSON.stringify(events[0])).not.toContain(promptSecret);
  });

  it('refuses to cancel a batch that already started or finished', async () => {
    const customer = await signedInCustomer();
    const { run } = await seededBatch(customer.cookie);
    const items = await runItems(run.id);
    await settle(items[0]!.generationJob.items[0]!.id);

    const running = await call('post', superAdmin.cookie, `/batches/${run.id}/cancel`, { reason });
    expect(running.status).toBe(409);
    expect(running.body.code).toBe('BATCH_NOT_QUEUED');

    await fail(items[1]!.generationJob.items[0]!.id, 'PROVIDER_ERROR');
    const settled = await call('post', superAdmin.cookie, `/batches/${run.id}/cancel`, { reason });
    expect(settled.status).toBe(409);
    expect(settled.body.code).toBe('BATCH_NOT_QUEUED');
    expect((await storedRun(run.id)).status).toBe('partial');
  });

  it('retries only system failures into a new run and never reuses the consumed quote', async () => {
    const customer = await signedInCustomer();
    const { run } = await seededBatch(customer.cookie);
    const items = await runItems(run.id);
    await settle(items[0]!.generationJob.items[0]!.id);
    await fail(items[1]!.generationJob.items[0]!.id, 'PROVIDER_ERROR');

    const response = await call('post', superAdmin.cookie, `/batches/${run.id}/retry-failed`, {
      reason,
    });
    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      resourceId: run.id,
      status: 'queued',
      totalCount: 1,
      retryOfRunId: run.id,
    });
    const retryId = response.body.data.retryRunId as string;
    expect(retryId).not.toBe(run.id);
    expect(await wallet.balance(customer.id)).toMatchObject({ available: 940n, held: 30n });
    expect(await db.database.client.workflowRun.count({ where: { userId: customer.id } })).toBe(2);

    const events = await db.database.client.adminAuditEvent.findMany({
      where: { action: 'batches.retry-failed' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      resourceId: run.id,
      outcome: 'allowed',
      metadata: { itemCount: 1, beforeStatus: 'partial', afterStatus: 'queued' },
    });
  });

  it('refuses a retry when the batch is unsettled or every failure is permanent', async () => {
    const customer = await signedInCustomer();
    const { run } = await seededBatch(customer.cookie);

    const unsettled = await call('post', superAdmin.cookie, `/batches/${run.id}/retry-failed`, {
      reason,
    });
    expect(unsettled.status).toBe(409);
    expect(unsettled.body.code).toBe('BATCH_NOT_SETTLED');

    const items = await runItems(run.id);
    for (const item of items) await fail(item.generationJob.items[0]!.id, 'MODEL_UNAVAILABLE');
    expect((await storedRun(run.id)).status).toBe('failed');

    const permanent = await call('post', superAdmin.cookie, `/batches/${run.id}/retry-failed`, {
      reason,
    });
    expect(permanent.status).toBe(409);
    expect(permanent.body.code).toBe('NO_RETRYABLE_FAILURES');
    expect(await db.database.client.workflowRun.count({ where: { userId: customer.id } })).toBe(1);
  });

  it('replays an idempotency key instead of disposing twice', async () => {
    const customer = await signedInCustomer();
    const { run } = await seededBatch(customer.cookie);
    const key = randomUUID();

    const first = await call('post', superAdmin.cookie, `/batches/${run.id}/cancel`, { reason }, key);
    const replay = await call('post', superAdmin.cookie, `/batches/${run.id}/cancel`, { reason }, key);
    expect(replay.status).toBe(201);
    expect(replay.body.data).toEqual(first.body.data);
    expect(
      await db.database.client.adminAuditEvent.count({
        where: { action: 'batches.cancel', resourceId: run.id },
      }),
    ).toBe(1);

    const conflicting = await call(
      'post',
      superAdmin.cookie,
      `/batches/${run.id}/cancel`,
      { reason: `${reason} changed` },
      key,
    );
    expect(conflicting.status).toBe(409);
    expect(conflicting.body.code).toBe('ADMIN_IDEMPOTENCY_CONFLICT');
  });

  it('audits a denied disposal without storing the reason or any customer content', async () => {
    const customer = await signedInCustomer();
    const { run } = await seededBatch(customer.cookie);

    await call('post', support.cookie, `/batches/${run.id}/cancel`, { reason });
    const denied = await db.database.client.adminAuditEvent.findMany({
      where: { action: 'batches.cancel', outcome: 'denied', resourceId: run.id },
    });
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ accountId: support.account.id, resourceId: run.id });
    expect(denied[0]!.reasonDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(denied[0])).not.toContain(reason);
    expect((await storedRun(run.id)).cancelRequested).toBe(false);
  });

  it('scopes reads to real records and hides unknown batches', async () => {
    expect((await call('get', superAdmin.cookie, `/batches/${randomUUID()}`)).status).toBe(404);
    expect((await call('get', superAdmin.cookie, `/batches/not-a-uuid`)).status).toBe(404);
    expect((await call('get', superAdmin.cookie, `/workflows/${randomUUID()}`)).status).toBe(404);
    expect((await call('get', superAdmin.cookie, '/batches?status=unknown')).status).toBe(400);
    expect((await call('get', superAdmin.cookie, '/workflows?status=unknown')).status).toBe(400);
    expect(
      (await call('post', superAdmin.cookie, `/batches/${randomUUID()}/cancel`, { reason })).status,
    ).toBe(404);
  });

  it('filters and paginates the batch list by state, owner and time', async () => {
    const customer = await signedInCustomer();
    const { workflow, run } = await seededBatch(customer.cookie);
    const version = (
      await call('get', superAdmin.cookie, `/workflows?q=${workflow.id}`)
    ).body.data;
    expect(version.rows.map((row: { id: string }) => row.id)).toEqual([workflow.id]);

    const byOwner = (await call('get', superAdmin.cookie, `/batches?userId=${customer.id}`)).body
      .data;
    expect(byOwner.rows.map((row: { id: string }) => row.id)).toEqual([run.id]);

    // The state filter follows this batch as it moves on, so it can never leak a
    // batch in another state nor drop one that matches.
    const mine = async (status: string) =>
      (await call('get', superAdmin.cookie, `/batches?status=${status}&userId=${customer.id}`))
        .body.data.rows;
    expect((await mine('queued')).map((row: { id: string }) => row.id)).toEqual([run.id]);
    const items = await runItems(run.id);
    await settle(items[0]!.generationJob.items[0]!.id);
    expect(await mine('queued')).toEqual([]);
    expect((await mine('processing')).map((row: { id: string }) => row.id)).toEqual([run.id]);
    expect(await mine('succeeded')).toEqual([]);

    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    expect((await call('get', superAdmin.cookie, `/batches?from=${tomorrow}`)).body.data.rows).toEqual(
      [],
    );

    const page = (await call('get', superAdmin.cookie, '/batches?limit=1')).body.data;
    expect(page.rows).toHaveLength(1);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(
      (await call('get', superAdmin.cookie, `/batches?limit=1&cursor=${page.nextCursor}`)).body.data
        .rows,
    ).toHaveLength(1);
    expect((await call('get', superAdmin.cookie, '/batches?cursor=nonsense')).status).toBe(400);
  });
});
