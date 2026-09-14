import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';
import { createApp } from '../../src/main.js';
import { IdentityService } from '../../src/modules/identity/identity.service.js';

const origin = 'http://localhost:3000';

const EXTERNAL_TOOL = 'product-background';

function seedTool(db: TestDatabase) {
  return db.database.client.toolDefinition.create({
    data: {
      externalId: EXTERNAL_TOOL,
      name: 'Product Background',
      description: 'Generate on-brand product backgrounds',
      category: 'Product',
      fieldSchema: [
        { id: 'subject', label: 'Subject', type: 'text', required: true },
        {
          id: 'style',
          label: 'Style',
          type: 'select',
          required: true,
          options: [
            { label: 'Clean', value: 'clean' },
            { label: 'Luxury', value: 'luxury' },
          ],
        },
      ],
      promptTemplate: 'A {{style}} product photo of {{subject}}',
      defaults: { modelId: 'simulation-image-v1', resolution: '1K', ratio: '1:1', count: 1 },
      maxAssets: 1,
      assetLabel: 'Product image',
      defaultModelId: 'simulation-image-v1',
      defaultOutputSpecId: 'standard',
      status: 'published',
      version: 3,
    },
  });
}

describe('workflow batch quoting', () => {
  let db: TestDatabase;
  let app: INestApplication;

  beforeAll(async () => {
    db = await createTestDatabase();
    app = await createApp({ nodeEnv: 'test', databaseUrl: db.url });
    await app.listen(0, '127.0.0.1');
    await seedTool(db);
  });

  afterAll(async () => {
    await app?.close();
    await db?.cleanup();
  });

  async function actor() {
    const id = randomUUID();
    await db.database.client.user.create({
      data: { id, email: `${id}@example.test`, username: id, passwordHash: 'unused' },
    });
    return { id, cookie: `viviai_session=${await app.get(IdentityService).createSession(id, 1)}` };
  }

  async function asset(userId: string) {
    return db.database.client.asset.create({
      data: {
        userId,
        name: 'reference',
        objectKey: `test/${randomUUID()}.png`,
        sha256: 'a'.repeat(64),
        width: 512,
        height: 512,
        byteSize: 128,
        contentType: 'image/png',
        status: 'ready',
      },
    });
  }

  const quote = (cookie: string, body: object) =>
    request(app.getHttpServer())
      .post('/api/workflow-run-quotes')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send(body);

  const createWorkflow = (cookie: string, body: object) =>
    request(app.getHttpServer())
      .post('/api/workflows')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send(body);

  function definition(assetIds: string[], rowKeys: string[]) {
    return {
      name: 'Campaign A',
      columns: [
        { id: 'ref', name: '参考图', type: 'reference' },
        {
          id: 'gen',
          name: '主图',
          type: 'generation',
          prompt: 'A clean product photo',
          sourceColumnIds: ['ref'],
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
      rows: rowKeys.map((rowKey, index) => ({
        rowKey,
        ...(assetIds[index] ? { cells: { ref: assetIds[index] } } : { cells: {} }),
      })),
    };
  }

  it('quotes every selected row and output column with one aggregate price', async () => {
    const user = await actor();
    const first = await asset(user.id);
    const second = await asset(user.id);
    const workflow = (await createWorkflow(user.cookie, definition([first.id, second.id], ['row-1', 'row-2']))).body.data;

    const response = await quote(user.cookie, { workflowId: workflow.id, rowIds: ['row-1', 'row-2'] });
    expect(response.status).toBe(201);
    const data = response.body.data;
    expect(data).toMatchObject({
      quoteId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      workflowId: workflow.id,
      workflowVersion: 1,
      submittable: true,
      totalCredits: 120,
    });
    expect(data.items).toHaveLength(4);
    expect(data.items.map((item: { rowKey: string; columnId: string }) => `${item.rowKey}:${item.columnId}`)).toEqual([
      'row-1:gen',
      'row-1:poster',
      'row-2:gen',
      'row-2:poster',
    ]);
    expect(data.items[0]).toMatchObject({
      status: 'ready',
      unitCredits: 30,
      totalCredits: 30,
      quoteId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(
      Date.parse(data.items[0].expiresAt) - Date.parse(data.items[0].createdAt),
    ).toBe(300_000);
    expect(JSON.stringify(data)).not.toContain('compiledPrompt');
    expect(JSON.stringify(data)).not.toContain('referenceAssetId');

    const stored = await db.database.client.workflowRunQuote.findUniqueOrThrow({
      where: { id: data.quoteId },
      include: { items: true },
    });
    expect(stored.totalCredits).toBe(120n);
    expect(stored.workflowVersion).toBe(1);
    expect(stored.items).toHaveLength(4);
    expect(stored.expiresAt.getTime()).toBe(Date.parse(data.expiresAt));
  });

  it('records the workflow origin on every child quote', async () => {
    const user = await actor();
    const stored = await asset(user.id);
    const workflow = (await createWorkflow(user.cookie, definition([stored.id], ['row-1']))).body.data;
    const data = (await quote(user.cookie, { workflowId: workflow.id, rowIds: ['row-1'] })).body.data;

    const children = await db.database.client.generationQuote.findMany({
      where: { originType: 'workflow', originId: workflow.id },
      include: { workflowRunQuoteItems: true },
    });
    expect(children).toHaveLength(2);
    expect(children.every((child) => child.originVersion === 1)).toBe(true);
    expect(children.every((child) => child.originSnapshot !== null)).toBe(true);
    expect(children.flatMap((child) => child.workflowRunQuoteItems)).toHaveLength(2);
    expect(children.map((child) => child.id).sort()).toEqual(
      data.items.map((item: { quoteId: string }) => item.quoteId).sort(),
    );
  });

  it('prices a tool column through its published version', async () => {
    const user = await actor();
    const workflow = (
      await createWorkflow(user.cookie, {
        name: 'Tool batch',
        columns: [
          { id: 'ref', name: '参考图', type: 'reference' },
          {
            id: 'styled',
            name: '工具列',
            type: 'tool',
            toolId: EXTERNAL_TOOL,
            toolVersion: 3,
            sourceColumnIds: [],
            values: { subject: 'bottle', style: 'clean' },
          },
        ],
        rows: [{ rowKey: 'row-1', cells: {} }],
      })
    ).body.data;

    const response = await quote(user.cookie, { workflowId: workflow.id, rowIds: ['row-1'] });
    expect(response.status).toBe(201);
    expect(response.body.data.items).toEqual([
      expect.objectContaining({ rowKey: 'row-1', columnId: 'styled', status: 'ready', totalCredits: 30 }),
    ]);
  });

  it('reports unusable rows and creates no quotes when any selected row is invalid', async () => {
    const user = await actor();
    const owned = await asset(user.id);
    const workflow = (
      await createWorkflow(user.cookie, definition([owned.id, randomUUID()], ['row-1', 'row-2']))
    ).body.data;

    const response = await quote(user.cookie, { workflowId: workflow.id, rowIds: ['row-1', 'row-2'] });
    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({ quoteId: null, submittable: false, totalCredits: 0 });
    expect(response.body.data.items).toContainEqual(
      expect.objectContaining({
        rowKey: 'row-2',
        columnId: 'gen',
        status: 'invalid',
        error: expect.objectContaining({ code: 'ASSET_NOT_FOUND' }),
      }),
    );
    expect(
      await db.database.client.workflowRunQuote.count({ where: { workflowId: workflow.id } }),
    ).toBe(0);
    expect(
      await db.database.client.generationQuote.count({ where: { originId: workflow.id } }),
    ).toBe(0);
  });

  it('does not freeze credits while quoting', async () => {
    const user = await actor();
    const owned = await asset(user.id);
    const workflow = (await createWorkflow(user.cookie, definition([owned.id], ['row-1']))).body.data;
    await quote(user.cookie, { workflowId: workflow.id, rowIds: ['row-1'] });
    expect(await db.database.client.creditLot.count({ where: { userId: user.id, held: { gt: 0n } } })).toBe(0);
  });

  it('produces a deterministic aggregate input hash for the same selection', async () => {
    const user = await actor();
    const owned = await asset(user.id);
    const workflow = (await createWorkflow(user.cookie, definition([owned.id], ['row-1']))).body.data;
    const first = (await quote(user.cookie, { workflowId: workflow.id, rowIds: ['row-1'] })).body.data;
    const second = (await quote(user.cookie, { workflowId: workflow.id, rowIds: ['row-1'] })).body.data;
    const hashes = await db.database.client.workflowRunQuote.findMany({
      where: { id: { in: [first.quoteId, second.quoteId] } },
      select: { inputHash: true },
    });
    expect(hashes).toHaveLength(2);
    expect(new Set(hashes.map((row) => row.inputHash)).size).toBe(1);
  });

  it('rejects a selection naming a row the workflow does not have', async () => {
    const user = await actor();
    const owned = await asset(user.id);
    const workflow = (await createWorkflow(user.cookie, definition([owned.id], ['row-1']))).body.data;
    const response = await quote(user.cookie, { workflowId: workflow.id, rowIds: ['ghost'] });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('INVALID_WORKFLOW_SELECTION');
  });

  it('rejects malformed selections and unknown or foreign workflows', async () => {
    const user = await actor();
    const other = await actor();
    const owned = await asset(user.id);
    const workflow = (await createWorkflow(user.cookie, definition([owned.id], ['row-1']))).body.data;

    expect((await quote(user.cookie, { workflowId: workflow.id, rowIds: [] })).status).toBe(400);
    expect((await quote(user.cookie, { workflowId: workflow.id })).status).toBe(400);
    expect((await quote(user.cookie, { rowIds: ['row-1'] })).status).toBe(400);
    expect((await quote(user.cookie, { workflowId: 'not-a-uuid', rowIds: ['row-1'] })).status).toBe(400);
    expect(
      (await quote(user.cookie, { workflowId: randomUUID(), rowIds: ['row-1'] })).status,
    ).toBe(404);
    expect(
      (await quote(other.cookie, { workflowId: workflow.id, rowIds: ['row-1'] })).status,
    ).toBe(404);
  });
});
