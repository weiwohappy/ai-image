import { createCipheriv, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';
import { createApp } from '../../src/main.js';
import { WalletService } from '../../src/modules/wallet/wallet.service.js';
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const merchant = generateKeyPairSync('rsa', { modulusLength: 2048 });
const keyId = 'PUB_KEY_ID_0000000000000001';
const apiKey = '12345678901234567890123456789012';
describe('real signed HTTP callbacks through SQL ledger', () => {
  let app: INestApplication;
  let db: TestDatabase;
  let dir: string;
  beforeAll(async () => {
    db = await createTestDatabase();
    dir = await mkdtemp(join(tmpdir(), 'viviai-payment-test-'));
    const privatePath = join(dir, 'merchant.pem');
    const publicPath = join(dir, 'platform.pem');
    await writeFile(privatePath, merchant.privateKey.export({ type: 'pkcs8', format: 'pem' }), {
      mode: 0o600,
    });
    await writeFile(publicPath, rsa.publicKey.export({ type: 'spki', format: 'pem' }));
    const env = {
      BILLING_ENABLED: 'false',
      WECHAT_PAY_ENABLED: 'true',
      WECHAT_PAY_MCH_ID: '1234567890',
      WECHAT_PAY_APP_ID: 'wx-test',
      WECHAT_PAY_SERIAL: 'AABBCCDDEEFF0011',
      WECHAT_PAY_PRIVATE_KEY_FILE: privatePath,
      WECHAT_PAY_API_V3_KEY: apiKey,
      WECHAT_PAY_PUBLIC_KEY_ID: keyId,
      WECHAT_PAY_PUBLIC_KEY_FILE: publicPath,
      WECHAT_PAY_NOTIFY_URL: 'https://merchant.example/api/webhooks/payments/wechat',
      ALIPAY_ENABLED: 'true',
      ALIPAY_APP_ID: '2026000000000001',
      ALIPAY_SELLER_ID: '2088000000000001',
      ALIPAY_PRIVATE_KEY_FILE: privatePath,
      ALIPAY_PUBLIC_KEY_FILE: publicPath,
      ALIPAY_NOTIFY_URL: 'https://merchant.example/api/webhooks/payments/alipay',
      ALIPAY_RETURN_URL: 'https://merchant.example/',
    };
    const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    try {
      Object.assign(process.env, env);
      app = await createApp({ nodeEnv: 'test', databaseUrl: db.url });
      await app.listen(0, '127.0.0.1');
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
  afterAll(async () => {
    await app?.close();
    await db?.cleanup();
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  async function order(channel: 'wechat' | 'alipay') {
    const userId = randomUUID();
    await db.database.client.user.create({
      data: {
        id: userId,
        email: `${userId}@example.test`,
        username: userId,
        passwordHash: 'unused',
      },
    });
    return db.database.client.paymentOrder.create({
      data: {
        userId,
        idempotencyKey: randomUUID(),
        requestHash: 'test',
        orderNo: randomUUID().replaceAll('-', ''),
        planId: 'test-v1',
        name: '测试积分包',
        amountMinor: 2900,
        credits: 1000,
        durationDays: 30,
        channel,
        merchantId: channel === 'wechat' ? '1234567890' : '2088000000000001',
        appId: channel === 'wechat' ? 'wx-test' : '2026000000000001',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
  }
  function wechatBody(orderNo: string, amount = 2900) {
    const nonce = '123456789012';
    const payload = {
      appid: 'wx-test',
      mchid: '1234567890',
      out_trade_no: orderNo,
      transaction_id: randomUUID().replaceAll('-', ''),
      trade_state: 'SUCCESS',
      trade_type: 'NATIVE',
      amount: { total: amount, currency: 'CNY' },
      success_time: new Date().toISOString(),
    };
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(apiKey), Buffer.from(nonce));
    cipher.setAAD(Buffer.from('transaction'));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(payload)),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString('base64');
    const raw = JSON.stringify({
      id: randomUUID(),
      create_time: new Date().toISOString(),
      event_type: 'TRANSACTION.SUCCESS',
      resource_type: 'encrypt-resource',
      resource: {
        algorithm: 'AEAD_AES_256_GCM',
        original_type: 'transaction',
        nonce,
        associated_data: 'transaction',
        ciphertext,
      },
    });
    const ts = String(Math.floor(Date.now() / 1000));
    return {
      raw,
      headers: {
        'Wechatpay-Timestamp': ts,
        'Wechatpay-Nonce': 'signed-nonce',
        'Wechatpay-Serial': keyId,
        'Wechatpay-Signature': sign(
          'RSA-SHA256',
          Buffer.from(`${ts}\nsigned-nonce\n${raw}\n`),
          rsa.privateKey,
        ).toString('base64'),
      },
    };
  }
  it('WeChat raw-body signatures survive JSON middleware; replays return 204 and issue once', async () => {
    const o = await order('wechat');
    const notification = wechatBody(o.orderNo);
    const notify = (raw = notification.raw) =>
      request(app.getHttpServer())
        .post('/api/webhooks/payments/wechat')
        .set(notification.headers)
        .set('Content-Type', 'application/json')
        .send(raw);
    expect((await notify(notification.raw + ' ')).status).toBe(400);
    const results = await Promise.all([notify(), notify(), notify()]);
    expect(results.map((r) => r.status)).toEqual([204, 204, 204]);
    expect(results[0]?.text).toBe('');
    expect((await new WalletService(db.database).balance(o.userId)).available).toBe(1000n);
  });
  it('a validly signed wrong amount gets no acknowledgement and no grant', async () => {
    const o = await order('wechat');
    const notification = wechatBody(o.orderNo, 1);
    expect(
      (
        await request(app.getHttpServer())
          .post('/api/webhooks/payments/wechat')
          .set(notification.headers)
          .set('Content-Type', 'application/json')
          .send(notification.raw)
      ).status,
    ).toBe(400);
    expect((await new WalletService(db.database).balance(o.userId)).available).toBe(0n);
    expect(await db.database.client.paymentEvent.count({ where: { orderId: o.id } })).toBe(0);
  });
  it('Alipay decoded form is verified by the official SDK and acknowledged as plain success', async () => {
    const o = await order('alipay');
    const fields = {
      app_id: o.appId,
      seller_id: o.merchantId,
      out_trade_no: o.orderNo,
      trade_no: '2026' + randomUUID().replaceAll('-', ''),
      total_amount: '29.00',
      trade_status: 'TRADE_SUCCESS',
      gmt_payment: new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' '),
      notify_id: randomUUID(),
      subject: '图片 + 创作积分包',
    };
    const canonical = Object.entries(fields)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join('&');
    const signature = sign('RSA-SHA256', Buffer.from(canonical), rsa.privateKey).toString('base64');
    const raw = new URLSearchParams({ ...fields, sign_type: 'RSA2', sign: signature }).toString();
    const notify = () =>
      request(app.getHttpServer()).post('/api/webhooks/payments/alipay').type('form').send(raw);
    for (const res of await Promise.all([notify(), notify()])) {
      expect(res.status).toBe(200);
      expect(res.text).toBe('success');
    }
    expect((await new WalletService(db.database).balance(o.userId)).available).toBe(1000n);
  });
});
