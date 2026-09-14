import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';

describe('workflow persistence schema', () => {
  let database: TestDatabase;
  let userId: string;
  let workflowId: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    const db = database.database.client;
    userId = (
      await db.user.create({
        data: { email: 'workflow-schema@example.test', username: 'workflow_schema', passwordHash: 'test' },
      })
    ).id;
    workflowId = (
      await db.workflow.create({
        data: { userId, name: 'Campaign', columns: [{ id: 'ref', name: 'Ref', type: 'reference' }] },
      })
    ).id;
  });

  afterAll(async () => {
    await database?.cleanup();
  });

  const now = () => new Date();
  const future = (ms = 300_000) => new Date(Date.now() + ms);

  async function createJob(idempotencyKey: string) {
    const db = database.database.client;
    const quote = await db.generationQuote.create({
      data: {
        userId,
        input: { source: 'create', modelId: 'simulation-image-v1', count: 1 },
        inputHash: `hash-${idempotencyKey}`,
        productVersion: 'simulation-image-v1',
        unitCredits: 30n,
        totalCredits: 30n,
        createdAt: now(),
        expiresAt: future(),
      },
    });
    return db.generationJob.create({
      data: {
        userId,
        quoteId: quote.id,
        operation: 'create',
        idempotencyKey,
        requestHash: `request-${idempotencyKey}`,
        input: { source: 'create', modelId: 'simulation-image-v1', count: 1 },
        queueDeadlineAt: future(),
        deliveryDeadlineAt: future(600_000),
      },
    });
  }

  async function createRun(idempotencyKey: string) {
    const db = database.database.client;
    return db.workflowRun.create({
      data: {
        userId,
        idempotencyKey,
        workflowSnapshot: { name: 'Campaign', columns: [], rows: [] },
        totalCount: 0,
        succeededCount: 0,
        failedCount: 0,
        cancelledCount: 0,
      },
    });
  }

  it('keeps stable row ids unique inside one workflow', async () => {
    const db = database.database.client;
    await db.workflowRow.create({ data: { workflowId, rowKey: 'row-1', sortOrder: 0, cells: {} } });
    await expect(
      db.workflowRow.create({ data: { workflowId, rowKey: 'row-1', sortOrder: 1, cells: {} } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('allows the same row key inside different workflows', async () => {
    const db = database.database.client;
    const other = await db.workflow.create({ data: { userId, name: 'Other', columns: [] } });
    await expect(
      db.workflowRow.create({ data: { workflowId: other.id, rowKey: 'row-1', sortOrder: 0, cells: {} } }),
    ).resolves.toMatchObject({ rowKey: 'row-1' });
  });

  it('keeps one quote item per row and column', async () => {
    const db = database.database.client;
    const job = await createJob('quote-item-job');
    const quote = await db.workflowRunQuote.create({
      data: {
        userId,
        workflowId,
        inputHash: 'aggregate-1',
        workflowVersion: 1,
        totalCredits: 30n,
        expiresAt: future(),
        items: {
          create: {
            rowKey: 'row-1',
            columnKey: 'gen-1',
            normalizedInput: {},
            originSnapshot: { originType: 'workflow', originId: workflowId, originVersion: 1 },
            unitCredits: 30n,
            totalCredits: 30n,
            generationQuoteId: job.quoteId,
          },
        },
      },
    });
    await expect(
      db.workflowRunQuoteItem.create({
        data: {
          quoteId: quote.id,
          rowKey: 'row-1',
          columnKey: 'gen-1',
          normalizedInput: {},
          originSnapshot: { originType: 'workflow', originId: workflowId, originVersion: 1 },
          unitCredits: 30n,
          totalCredits: 30n,
          generationQuoteId: job.quoteId,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('keeps one run item per row and column', async () => {
    const db = database.database.client;
    const run = await createRun('run-item-run');
    const jobA = await createJob('run-item-job-a');
    const jobB = await createJob('run-item-job-b');
    await db.workflowRunItem.create({
      data: { runId: run.id, rowKey: 'row-1', columnKey: 'gen-1', generationJobId: jobA.id },
    });
    await expect(
      db.workflowRunItem.create({
        data: { runId: run.id, rowKey: 'row-1', columnKey: 'gen-1', generationJobId: jobB.id },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('links each run item to exactly one generation job', async () => {
    const db = database.database.client;
    const run = await createRun('one-job-run');
    const job = await createJob('one-job');
    await db.workflowRunItem.create({
      data: { runId: run.id, rowKey: 'row-1', columnKey: 'gen-1', generationJobId: job.id },
    });
    await expect(
      db.workflowRunItem.create({
        data: { runId: run.id, rowKey: 'row-2', columnKey: 'gen-1', generationJobId: job.id },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('keeps user idempotency keys unique across runs', async () => {
    await createRun('shared-idempotency-key');
    await expect(createRun('shared-idempotency-key')).rejects.toMatchObject({ code: 'P2002' });
  });

  it('rejects negative progress counts', async () => {
    const db = database.database.client;
    await expect(
      db.workflowRun.create({
        data: {
          userId,
          idempotencyKey: 'negative-counts',
          workflowSnapshot: {},
          totalCount: -1,
          succeededCount: 0,
          failedCount: 0,
          cancelledCount: 0,
        },
      }),
    ).rejects.toThrow();
    await expect(
      db.workflowRun.create({
        data: {
          userId,
          idempotencyKey: 'negative-failed',
          workflowSnapshot: {},
          totalCount: 1,
          succeededCount: 0,
          failedCount: -1,
          cancelledCount: 0,
        },
      }),
    ).rejects.toThrow();
  });
});
