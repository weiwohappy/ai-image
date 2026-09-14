import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';
import { jobDto } from '../../src/modules/generation/job-serializer.js';

describe('generation origin persistence', () => {
  let database: TestDatabase;
  let userId: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    const db = database.database.client;
    userId = (
      await db.user.create({
        data: {
          email: 'origin-user@example.test',
          username: 'origin-user',
          passwordHash: 'test',
        },
      })
    ).id;
  });

  afterAll(async () => {
    await database?.cleanup();
  });

  const originInput = { source: 'create', modelId: 'simulation-image-v1', count: 1 };

  async function createJobWithOrigin(origin: {
    type: string;
    id: string;
    version: number;
    snapshot: object;
  }) {
    const db = database.database.client;
    const now = new Date();
    const quote = await db.generationQuote.create({
      data: {
        userId,
        input: originInput,
        inputHash: `quote-${origin.id}`,
        productVersion: 'simulation-image-v1',
        unitCredits: 30n,
        totalCredits: 30n,
        createdAt: now,
        expiresAt: new Date(now.getTime() + 300_000),
        originType: origin.type,
        originId: origin.id,
        originVersion: origin.version,
        originSnapshot: origin.snapshot,
      },
    });
    return db.generationJob.create({
      data: {
        userId,
        quoteId: quote.id,
        operation: 'create',
        idempotencyKey: `key-${origin.id}`,
        requestHash: `request-${origin.id}`,
        input: originInput,
        queueDeadlineAt: new Date(now.getTime() + 300_000),
        deliveryDeadlineAt: new Date(now.getTime() + 600_000),
        originType: origin.type,
        originId: origin.id,
        originVersion: origin.version,
        originSnapshot: origin.snapshot,
        items: { create: [{ ordinal: 0, unitCredits: 30n, status: 'succeeded' }] },
      },
      include: { items: { orderBy: { ordinal: 'asc' as const } } },
    });
  }

  it('serializes tool origin identity without exposing the origin snapshot', async () => {
    const job = await createJobWithOrigin({
      type: 'tool',
      id: 'product-background',
      version: 3,
      snapshot: { compiledPrompt: 'a compiled prompt that must stay private' },
    });
    expect(jobDto(job)).toMatchObject({ toolId: 'product-background', toolVersion: 3 });
    expect(jobDto(job)).not.toHaveProperty('originSnapshot');
    expect(JSON.stringify(jobDto(job))).not.toContain('compiledPrompt');
  });

  it('serializes workflow origin identity', async () => {
    const job = await createJobWithOrigin({
      type: 'workflow',
      id: 'workflow-123',
      version: 2,
      snapshot: { columns: [], rows: [] },
    });
    expect(jobDto(job)).toMatchObject({ workflowId: 'workflow-123' });
    expect(jobDto(job)).not.toHaveProperty('originSnapshot');
  });

  it('requires every origin field together whenever the origin type is present', async () => {
    const db = database.database.client;
    const now = new Date();
    const quote = await db.generationQuote.create({
      data: {
        userId,
        input: originInput,
        inputHash: 'quote-bare',
        productVersion: 'simulation-image-v1',
        unitCredits: 30n,
        totalCredits: 30n,
        createdAt: now,
        expiresAt: new Date(now.getTime() + 300_000),
      },
    });
    await expect(
      db.generationJob.create({
        data: {
          userId,
          quoteId: quote.id,
          operation: 'create',
          idempotencyKey: 'key-incomplete-origin',
          requestHash: 'request-incomplete-origin',
          input: originInput,
          queueDeadlineAt: new Date(now.getTime() + 300_000),
          deliveryDeadlineAt: new Date(now.getTime() + 600_000),
          originType: 'tool',
          originId: 'product-background',
        },
      }),
    ).rejects.toThrow();
    await expect(
      db.generationQuote.create({
        data: {
          userId,
          input: originInput,
          inputHash: 'quote-bad-type',
          productVersion: 'simulation-image-v1',
          unitCredits: 30n,
          totalCredits: 30n,
          createdAt: now,
          expiresAt: new Date(now.getTime() + 300_000),
          originType: 'direct',
          originId: 'x',
          originVersion: 1,
          originSnapshot: {},
        },
      }),
    ).rejects.toThrow();
  });
});
