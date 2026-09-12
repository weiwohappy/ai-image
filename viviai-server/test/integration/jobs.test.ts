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
const input = {
  source: 'create',
  modelId: 'simulation-image-v1',
  prompt: 'Blue cup',
  resolution: '1K',
  ratio: '1:1',
  count: 4,
};
describe('quoted idempotent job acceptance', () => {
  let db: TestDatabase;
  let app: INestApplication;
  let wallet: WalletService;
  let storageRoot: string;
  beforeAll(async () => {
    db = await createTestDatabase();
    storageRoot = await mkdtemp(join(tmpdir(), 'viviai-jobs-test-'));
    app = await createApp({ nodeEnv: 'test', databaseUrl: db.url, localStorageRoot: storageRoot });
    await app.listen(0, '127.0.0.1');
    wallet = new WalletService(db.database);
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
    await db.database.transaction((tx) => wallet.grant(tx, id, 'test-promo', credits, null));
    return { id, cookie: `viviai_session=${await app.get(IdentityService).createSession(id, 1)}` };
  }
  const post = (path: string, cookie: string, body: object, key = randomUUID()) =>
    request(app.getHttpServer())
      .post(`/api/${path}`)
      .set('Origin', 'http://localhost:3000')
      .set('Cookie', cookie)
      .set('Idempotency-Key', key)
      .send(body);
  it('100 simultaneous same-key requests produce one job and one hold per item', async () => {
    const user = await actor();
    const quote = (await post('generation-quotes', user.cookie, input)).body.data;
    const body = { quoteId: quote.id, input };
    const key = randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 100 }, () => post('generation-tasks', user.cookie, body, key)),
    );
    expect(responses.map((r) => r.status)).toEqual(Array(100).fill(201));
    expect(new Set(responses.map((r) => r.body.data.id)).size).toBe(1);
    expect(await db.database.client.generationJob.count({ where: { userId: user.id } })).toBe(1);
    expect(await wallet.balance(user.id)).toMatchObject({ available: 880n, held: 120n });
    expect(
      await db.database.client.outboxEvent.count({
        where: { itemId: { in: responses[0]!.body.data.items.map((i: { id: string }) => i.id) } },
      }),
    ).toBe(4);
    await db.database.client.generationQuote.update({
      where: { id: quote.id },
      data: { expiresAt: new Date(Date.now() - 1000), createdAt: new Date(Date.now() - 400_000) },
    });
    expect((await post('generation-tasks', user.cookie, body, key)).body.data.id).toBe(
      responses[0]!.body.data.id,
    );
    expect(
      (
        await post(
          'generation-tasks',
          user.cookie,
          { ...body, input: { ...input, prompt: 'changed' } },
          key,
        )
      ).status,
    ).toBe(409);
    expect((await post('generation-tasks', user.cookie, body)).status).toBe(409);
  }, 30_000);
  it('two concurrent jobs cannot spend a balance sufficient for only one', async () => {
    const user = await actor(30n);
    const one = { ...input, count: 1 };
    const quotes = await Promise.all([0, 1].map(() => post('generation-quotes', user.cookie, one)));
    const responses = await Promise.all(
      quotes.map((q) =>
        post('generation-tasks', user.cookie, { quoteId: q.body.data.id, input: one }),
      ),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([201, 402]);
    expect(await wallet.balance(user.id)).toMatchObject({ available: 0n, held: 30n });
  });
  it('queued cancellation is owner-scoped and idempotently releases all holds', async () => {
    const user = await actor();
    const other = await actor();
    const q = (await post('generation-quotes', user.cookie, input)).body.data;
    const job = (await post('generation-tasks', user.cookie, { quoteId: q.id, input })).body.data;
    expect((await post(`generation-tasks/${job.id}/cancel`, other.cookie, {})).status).toBe(404);
    const result = await post(`generation-tasks/${job.id}/cancel`, user.cookie, {});
    expect(result.body.data.status).toBe('cancelled');
    await post(`generation-tasks/${job.id}/cancel`, user.cookie, {});
    expect(await wallet.balance(user.id)).toMatchObject({ available: 1000n, held: 0n });
    expect(
      (await request(app.getHttpServer()).get('/api/me').set('Cookie', user.cookie)).body.data
        .credits,
    ).toBe(1000);
  });
  it('remix pins both owned images and rejects foreign or deleted references', async () => {
    const user = await actor();
    const other = await actor();
    const assets = app.get(AssetService);
    const bytes = await sharp({
      create: { width: 16, height: 24, channels: 3, background: 'blue' },
    })
      .png()
      .toBuffer();
    const reference = await assets.upload(user.id, bytes, 'reference');
    const subject = await assets.upload(user.id, bytes, 'subject');
    const remix = {
      ...input,
      source: 'remix',
      referenceAssetId: reference.id,
      subjectAssetId: subject.id,
      strength: 'balanced',
      count: 1,
    };
    expect((await post('generation-quotes', other.cookie, remix)).status).toBe(404);
    const quote = (await post('generation-quotes', user.cookie, remix)).body.data;
    const response = await post('remix-tasks', user.cookie, { quoteId: quote.id, input: remix });
    expect(response.status).toBe(201);
    const pins = await db.database.client.assetPin.findMany({
      where: { jobId: response.body.data.id },
      orderBy: { role: 'asc' },
    });
    expect(pins.map((p) => p.role)).toEqual(['reference', 'subject']);
    const nextQuote = (await post('generation-quotes', user.cookie, remix)).body.data;
    await assets.remove(user.id, reference.id);
    expect(
      (await post('remix-tasks', user.cookie, { quoteId: nextQuote.id, input: remix })).status,
    ).toBe(404);
  });
  it('expired unused quotes cannot spend credits, failed items retry through a new quote', async () => {
    const user = await actor();
    const q = (await post('generation-quotes', user.cookie, input)).body.data;
    await db.database.client.generationQuote.update({
      where: { id: q.id },
      data: { createdAt: new Date(Date.now() - 400_000), expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await post('generation-tasks', user.cookie, { quoteId: q.id, input })).body.code).toBe(
      'QUOTE_EXPIRED',
    );
    expect(await wallet.balance(user.id)).toMatchObject({ available: 1000n, held: 0n });
    const goodQuote = (await post('generation-quotes', user.cookie, input)).body.data;
    const job = (await post('generation-tasks', user.cookie, { quoteId: goodQuote.id, input })).body
      .data;
    await db.database.transaction(async (tx) => {
      for (const [index, item] of job.items.entries()) {
        await wallet.settle(tx, item.id, index < 2 ? 'consume' : 'release', new Date());
        await tx.generationItem.update({
          where: { id: item.id },
          data: { status: index < 2 ? 'succeeded' : 'failed' },
        });
      }
    });
    const retryInput = { ...input, count: 2 };
    const retryQuote = (await post('generation-quotes', user.cookie, retryInput)).body.data;
    const retry = await post(`generation-tasks/${job.id}/retry`, user.cookie, {
      quoteId: retryQuote.id,
      input: retryInput,
    });
    expect(retry.status).toBe(201);
    expect(retry.body.data.id).not.toBe(job.id);
    expect(retry.body.data.items).toHaveLength(2);
    expect(await wallet.balance(user.id)).toMatchObject({
      available: 880n,
      held: 60n,
      consumed: 60n,
    });
  });
});
