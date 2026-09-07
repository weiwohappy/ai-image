import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';
import { createApp } from '../../src/main.js';
describe('payment HTTP security and disabled default', () => {
  let db: TestDatabase;
  let app: INestApplication;
  beforeAll(async () => {
    db = await createTestDatabase();
    app = await createApp({ nodeEnv: 'test', databaseUrl: db.url });
    await app.listen(0, '127.0.0.1');
  });
  afterAll(async () => {
    await app?.close();
    await db?.cleanup();
  });
  it('catalog exposes disabled channels without secrets or selling unconfigured packs', async () => {
    const res = await request(app.getHttpServer()).get('/api/billing/catalog');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      enabled: false,
      plans: [],
      channels: [
        { channel: 'wechat', enabled: false },
        { channel: 'alipay', enabled: false },
      ],
    });
  });
  it('requires a genuine backend session to create orders, not a Mock identity header', async () => {
    expect((await request(app.getHttpServer()).get('/api/billing/me')).status).toBe(401);
    const res = await request(app.getHttpServer())
      .post('/api/billing/orders')
      .set('Origin', 'http://localhost:3000')
      .set('Idempotency-Key', randomUUID())
      .send({ planId: 'test-v1', channel: 'wechat', userId: randomUUID() });
    expect(res.status).toBe(401);
  });
  it('only exact payment notification endpoints bypass Origin and reject unverified callbacks', async () => {
    for (const channel of ['wechat', 'alipay']) {
      const res = await request(app.getHttpServer())
        .post(`/api/webhooks/payments/${channel}`)
        .send({ trade_status: 'TRADE_SUCCESS' });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.body.code).not.toBe('CSRF_ORIGIN');
    }
    for (const path of [
      'billing/orders',
      'webhooks/payments/wechat/extra',
      'webhooks/payments/unknown',
      'auth/logout',
    ]) {
      const res = await request(app.getHttpServer()).post(`/api/${path}`).send({});
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('CSRF_ORIGIN');
    }
  });
});
