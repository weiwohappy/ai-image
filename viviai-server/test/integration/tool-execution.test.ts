import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import sharp from 'sharp';
import type { INestApplication } from '@nestjs/common';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';
import { createApp } from '../../src/main.js';
import { IdentityService } from '../../src/modules/identity/identity.service.js';
import { WalletService } from '../../src/modules/wallet/wallet.service.js';
import { AssetService } from '../../src/modules/assets/assets.service.js';

const toolInput = {
  toolId: 'product-background',
  toolVersion: 3,
  assetIds: [],
  values: { subject: 'a perfume bottle', style: 'clean' },
  modelId: 'simulation-image-v1',
  resolution: '1K',
  ratio: '1:1',
  count: 2,
};

function seedTool(db: TestDatabase, overrides: Record<string, unknown> = {}) {
  return db.database.client.toolDefinition.create({
    data: {
      externalId: 'product-background',
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
      ...overrides,
    },
  });
}

describe('quoted AI tool execution', () => {
  let db: TestDatabase;
  let app: INestApplication;
  let wallet: WalletService;
  let storageRoot: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    storageRoot = await mkdtemp(join(tmpdir(), 'viviai-tool-exec-test-'));
    app = await createApp({ nodeEnv: 'test', databaseUrl: db.url, localStorageRoot: storageRoot });
    await app.listen(0, '127.0.0.1');
    wallet = new WalletService(db.database);
    await seedTool(db);
  });

  afterAll(async () => {
    await app?.close();
    await db?.cleanup();
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  });

  async function actor(credits = 1000n) {
    const id = randomUUID();
    await db.database.client.user.create({
      data: { id, email: `${id}@example.test`, username: id, passwordHash: 'unused' },
    });
    if (credits > 0n) {
      await db.database.transaction((tx) => wallet.grant(tx, id, 'test-promo', credits, null));
    }
    return { id, cookie: `viviai_session=${await app.get(IdentityService).createSession(id, 1)}` };
  }

  const quote = (cookie: string, body: object) =>
    request(app.getHttpServer())
      .post('/api/tool-run-quotes')
      .set('Origin', 'http://localhost:3000')
      .set('Cookie', cookie)
      .send(body);

  const run = (cookie: string, body: object, key = randomUUID()) =>
    request(app.getHttpServer())
      .post('/api/tool-runs')
      .set('Origin', 'http://localhost:3000')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key)
      .send(body);

  it('quotes a published tool without revealing the compiled prompt', async () => {
    const user = await actor();
    const response = await quote(user.cookie, toolInput);
    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      quoteId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      toolId: 'product-background',
      toolVersion: 3,
      modelId: 'simulation-image-v1',
      resolution: '1K',
      ratio: '1:1',
      count: 2,
      unitCredits: 30,
      totalCredits: 60,
    });
    expect(
      Date.parse(response.body.data.expiresAt) - Date.parse(response.body.data.createdAt),
    ).toBe(300_000);
    expect(JSON.stringify(response.body.data)).not.toContain('compiledPrompt');
    expect(response.body.data).not.toHaveProperty('prompt');
    expect(response.body.data).not.toHaveProperty('input');
    expect(response.body.data).not.toHaveProperty('inputHash');
  });

  it('submits a quote into a tool-origin job that freezes credits', async () => {
    const user = await actor();
    const q = (await quote(user.cookie, toolInput)).body.data;
    const response = await run(user.cookie, { quoteId: q.quoteId });
    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      id: expect.any(String),
      toolId: 'product-background',
      toolVersion: 3,
      status: 'queued',
      items: expect.arrayContaining([expect.objectContaining({ status: 'queued' })]),
    });
    expect(response.body.data.items).toHaveLength(2);
    expect(response.body.data).not.toHaveProperty('originSnapshot');
    expect(await wallet.balance(user.id)).toMatchObject({ available: 940n, held: 60n });
    const job = await db.database.client.generationJob.findUniqueOrThrow({
      where: { id: response.body.data.id },
    });
    expect(job.originType).toBe('tool');
    expect(job.originId).toBe('product-background');
    expect(job.originVersion).toBe(3);
    const itemIds = response.body.data.items.map((item: { id: string }) => item.id);
    expect(await db.database.client.outboxEvent.count({ where: { itemId: { in: itemIds } } })).toBe(
      2,
    );
  });

  it('rejects a quote for an offline or missing tool', async () => {
    const user = await actor();
    expect((await quote(user.cookie, { ...toolInput, toolId: 'missing-tool' })).status).toBe(404);
    await db.database.client.toolDefinition.update({
      where: { externalId: 'product-background' },
      data: { status: 'draft' },
    });
    expect((await quote(user.cookie, toolInput)).status).toBe(404);
    await db.database.client.toolDefinition.update({
      where: { externalId: 'product-background' },
      data: { status: 'published' },
    });
  });

  it('rejects a stale tool version and unsupported model parameters', async () => {
    const user = await actor();
    expect((await quote(user.cookie, { ...toolInput, toolVersion: 4 })).status).toBe(422);
    expect((await quote(user.cookie, { ...toolInput, resolution: '2K' })).status).toBe(400);
    expect((await quote(user.cookie, { ...toolInput, modelId: 'nano-banana' })).status).toBe(400);
  });

  it('rejects quotes that reference foreign or deleted assets, and submits fail after deletion', async () => {
    const user = await actor();
    const assets = app.get(AssetService);
    const bytes = await sharp({
      create: { width: 16, height: 24, channels: 3, background: 'blue' },
    })
      .png()
      .toBuffer();
    const owned = await assets.upload(user.id, bytes, 'reference');
    expect((await quote(user.cookie, { ...toolInput, assetIds: [owned.id] })).status).toBe(201);
    expect(
      (await quote(user.cookie, { ...toolInput, assetIds: [randomUUID()] })).status,
    ).toBe(404);
    const other = await actor();
    expect((await quote(other.cookie, { ...toolInput, assetIds: [owned.id] })).status).toBe(404);

    const q = (await quote(user.cookie, { ...toolInput, assetIds: [owned.id] })).body.data;
    await assets.remove(user.id, owned.id);
    expect((await run(user.cookie, { quoteId: q.quoteId })).status).toBe(404);
  });

  it('enforces one-time use, expiry and owner scope', async () => {
    const owner = await actor();
    const other = await actor();
    const q = (await quote(owner.cookie, toolInput)).body.data;
    expect((await run(other.cookie, { quoteId: q.quoteId })).status).toBe(404);

    const first = await run(owner.cookie, { quoteId: q.quoteId });
    expect(first.status).toBe(201);
    expect((await run(owner.cookie, { quoteId: q.quoteId })).status).toBe(409);

    const expired = (await quote(owner.cookie, toolInput)).body.data;
    await db.database.client.generationQuote.update({
      where: { id: expired.quoteId },
      data: { createdAt: new Date(Date.now() - 400_000), expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await run(owner.cookie, { quoteId: expired.quoteId })).body.code).toBe('QUOTE_EXPIRED');
  });

  it('rejects submission without sufficient balance', async () => {
    const poor = await actor(0n);
    const q = (await quote(poor.cookie, { ...toolInput, count: 1 })).body.data;
    expect((await run(poor.cookie, { quoteId: q.quoteId })).status).toBe(402);
    expect(await wallet.balance(poor.id)).toMatchObject({ available: 0n, held: 0n });
  });
});
