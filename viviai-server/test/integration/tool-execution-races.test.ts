import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';
import { createApp } from '../../src/main.js';
import { IdentityService } from '../../src/modules/identity/identity.service.js';
import { WalletService } from '../../src/modules/wallet/wallet.service.js';

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

describe('idempotent tool-run submission', () => {
  let db: TestDatabase;
  let app: INestApplication;
  let wallet: WalletService;

  beforeAll(async () => {
    db = await createTestDatabase();
    app = await createApp({ nodeEnv: 'test', databaseUrl: db.url });
    await app.listen(0, '127.0.0.1');
    wallet = new WalletService(db.database);
    await db.database.client.toolDefinition.create({
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
      },
    });
  });

  afterAll(async () => {
    await app?.close();
    await db?.cleanup();
  });

  async function actor(credits = 1000n) {
    const id = randomUUID();
    await db.database.client.user.create({
      data: { id, email: `${id}@example.test`, username: id, passwordHash: 'unused' },
    });
    await db.database.transaction((tx) => wallet.grant(tx, id, 'test-promo', credits, null));
    return { id, cookie: `viviai_session=${await app.get(IdentityService).createSession(id, 1)}` };
  }

  const quote = (cookie: string, body: object = toolInput) =>
    request(app.getHttpServer())
      .post('/api/tool-run-quotes')
      .set('Origin', 'http://localhost:3000')
      .set('Cookie', cookie)
      .send(body)
      .then((response) => response.body.data);

  const run = (cookie: string, quoteId: string, key = randomUUID()) =>
    request(app.getHttpServer())
      .post('/api/tool-runs')
      .set('Origin', 'http://localhost:3000')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key)
      .send({ quoteId });

  it('100 simultaneous same-key requests produce one job and one hold per item', async () => {
    const user = await actor();
    const q = await quote(user.cookie);
    const key = randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 100 }, () => run(user.cookie, q.quoteId, key)),
    );
    expect(responses.map((r) => r.status)).toEqual(Array(100).fill(201));
    expect(new Set(responses.map((r) => r.body.data.id)).size).toBe(1);
    expect(await db.database.client.generationJob.count({ where: { userId: user.id } })).toBe(1);
    expect(await wallet.balance(user.id)).toMatchObject({ available: 940n, held: 60n });
  }, 30_000);

  it('replays a completed submission and rejects key reuse for a different quote', async () => {
    const user = await actor();
    const first = await quote(user.cookie);
    const second = await quote(user.cookie);
    const key = randomUUID();
    const ok = await run(user.cookie, first.quoteId, key);
    expect(ok.status).toBe(201);

    const replay = await run(user.cookie, first.quoteId, key);
    expect(replay.status).toBe(201);
    expect(replay.body.data.id).toBe(ok.body.data.id);

    const conflict = await run(user.cookie, second.quoteId, key);
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('two concurrent submissions of one quote produce a single consumed job', async () => {
    const user = await actor(30n);
    const q = await quote(user.cookie, { ...toolInput, count: 1 });
    const responses = await Promise.all([
      run(user.cookie, q.quoteId),
      run(user.cookie, q.quoteId),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await db.database.client.generationJob.count({ where: { userId: user.id } })).toBe(1);
    expect(await wallet.balance(user.id)).toMatchObject({ available: 0n, held: 30n });
  });
});
