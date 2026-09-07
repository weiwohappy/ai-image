import {
  createCipheriv,
  generateKeyPairSync,
  sign as rsaSign,
  verify as rsaVerify,
} from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';
import { AlipayPaymentAdapter, type AlipaySdkPort } from '../src/modules/billing/alipay.js';
import type {
  PaymentHttpRequest,
  PaymentHttpResponse,
  PaymentHttpTransport,
} from '../src/modules/billing/payment-security.js';
import { WechatPaymentAdapter } from '../src/modules/billing/wechat.js';

const NOW = new Date('2026-09-07T04:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const ORDER_NO = 'ORDER_20260907_000001';

const merchantKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const wechatKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const alipayKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });

const merchantPrivateKey = merchantKeys.privateKey
  .export({ type: 'pkcs8', format: 'pem' })
  .toString();
const wechatPrivateKey = wechatKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const wechatPublicKey = wechatKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const alipayPrivateKey = alipayKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const alipayPublicKey = alipayKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();

const WECHAT_KEY_ID = 'PUB_KEY_ID_3000000001';
const API_V3_KEY = Buffer.from('0123456789abcdef0123456789abcdef');

const wechatConfig = {
  merchantId: '1900000109',
  appId: 'wx1234567890123456',
  merchantSerial: '7E3A12B4C5D6E7F8',
  merchantPrivateKey,
  apiV3Key: API_V3_KEY,
  platformPublicKeys: { [WECHAT_KEY_ID]: wechatPublicKey },
  notifyUrl: 'https://merchant.example/webhooks/payments/wechat',
  now: () => NOW,
};

const alipayConfig = {
  appId: '2026000000000001',
  sellerId: '2088000000000001',
  privateKey: alipayPrivateKey,
  alipayPublicKey,
  notifyUrl: 'https://merchant.example/webhooks/payments/alipay',
  returnUrl: 'https://merchant.example/billing/return',
};

describe('WechatPaymentAdapter', () => {
  test('decrypts a valid signed success notification into a 2900-fen paid fact', () => {
    const adapter = new WechatPaymentAdapter(wechatConfig, rejectingTransport);
    const notification = makeWechatNotification();

    expect(adapter.verifyNotification(notification.body, notification.headers)).toEqual({
      channel: 'wechat',
      eventId: 'EVT_WECHAT_000001',
      orderNo: ORDER_NO,
      tradeNo: '420000000020260907000001',
      merchantId: wechatConfig.merchantId,
      appId: wechatConfig.appId,
      amountMinor: 2900,
      currency: 'CNY',
      paidAt: new Date('2026-09-07T03:58:00+00:00'),
    });
  });

  test.each([
    [
      'changed body byte',
      (fixture: WechatNotification) => ({ ...fixture, body: mutateByte(fixture.body) }),
    ],
    [
      'changed signature',
      (fixture: WechatNotification) => ({
        ...fixture,
        headers: {
          ...fixture.headers,
          'wechatpay-signature': Buffer.alloc(256).toString('base64'),
        },
      }),
    ],
    [
      'unknown key id',
      (fixture: WechatNotification) => ({
        ...fixture,
        headers: { ...fixture.headers, 'wechatpay-serial': 'PUB_KEY_ID_3999999999' },
      }),
    ],
    ['stale timestamp', () => makeWechatNotification({ timestamp: NOW_SECONDS - 301 })],
    ['wrong merchant', () => makeWechatNotification({ payment: { mchid: '1900000110' } })],
    ['wrong app', () => makeWechatNotification({ payment: { appid: 'wx9999999999999999' } })],
  ])('rejects a notification with %s', (_name, alter) => {
    const adapter = new WechatPaymentAdapter(wechatConfig, rejectingTransport);
    const fixture = alter(makeWechatNotification());
    expect(() => adapter.verifyNotification(fixture.body, fixture.headers)).toThrow();
  });

  test('verifies a Native checkout response before returning its QR URL', async () => {
    const requests: PaymentHttpRequest[] = [];
    const transport = signedWechatTransport(requests, () => ({
      code_url: 'weixin://wxpay/bizpayurl?pr=valid123',
    }));
    const adapter = new WechatPaymentAdapter(wechatConfig, transport);

    await expect(
      adapter.create({
        orderNo: ORDER_NO,
        amountMinor: 2900,
        description: 'ViviAI 2900 credits',
        expiresAt: new Date('2026-09-07T04:15:00.000Z'),
      }),
    ).resolves.toEqual({ kind: 'qr', url: 'weixin://wxpay/bizpayurl?pr=valid123' });

    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request).toMatchObject({
      method: 'POST',
      url: 'https://api.mch.weixin.qq.com/v3/pay/transactions/native',
      timeoutMs: 10_000,
      maxResponseBytes: 64 * 1024,
      followRedirects: false,
    });
    const payload = JSON.parse(request.body!.toString()) as Record<string, unknown>;
    expect(payload).toMatchObject({
      appid: wechatConfig.appId,
      mchid: wechatConfig.merchantId,
      out_trade_no: ORDER_NO,
      description: 'ViviAI 2900 credits',
      notify_url: wechatConfig.notifyUrl,
      amount: { total: 2900, currency: 'CNY' },
      time_expire: '2026-09-07T12:15:00+08:00',
    });
    expectWechatAuthorization(request);
  });

  test('rejects a checkout body that was changed after response signing', async () => {
    const transport = signedWechatTransport(
      [],
      () => ({
        code_url: 'weixin://wxpay/bizpayurl?pr=valid123',
      }),
      true,
    );
    const adapter = new WechatPaymentAdapter(wechatConfig, transport);

    await expect(
      adapter.create({
        orderNo: ORDER_NO,
        amountMinor: 2900,
        description: 'ViviAI credits',
        expiresAt: new Date('2026-09-07T04:15:00.000Z'),
      }),
    ).rejects.toThrow();
  });

  test('verifies a query response and returns null only for an authenticated unpaid state', async () => {
    const paidAdapter = new WechatPaymentAdapter(
      wechatConfig,
      signedWechatTransport([], () => wechatPaidPayment()),
    );
    await expect(paidAdapter.query(ORDER_NO)).resolves.toMatchObject({
      channel: 'wechat',
      eventId: 'wechat:query:420000000020260907000001',
      amountMinor: 2900,
    });

    const unpaidAdapter = new WechatPaymentAdapter(
      wechatConfig,
      signedWechatTransport([], () => ({
        ...wechatPaidPayment(),
        trade_state: 'NOTPAY',
        transaction_id: undefined,
        success_time: undefined,
        amount: undefined,
      })),
    );
    await expect(unpaidAdapter.query(ORDER_NO)).resolves.toBeNull();
  });

  test('rejects an authenticated notification with an unknown event type', () => {
    const adapter = new WechatPaymentAdapter(wechatConfig, rejectingTransport);
    const notification = makeWechatNotification({ eventType: 'TRANSACTION.UNKNOWN' });
    expect(() => adapter.verifyNotification(notification.body, notification.headers)).toThrow();
  });
});

describe('AlipayPaymentAdapter', () => {
  test('verifies a decoded RSA2 form notification and converts 29.01 yuan to 2901 fen', () => {
    const adapter = new AlipayPaymentAdapter(alipayConfig);
    const body = makeAlipayNotification();

    expect(
      adapter.verifyNotification(body, { 'content-type': 'application/x-www-form-urlencoded' }),
    ).toEqual({
      channel: 'alipay',
      eventId: '202609070000000000000001',
      orderNo: ORDER_NO,
      tradeNo: '202609072200100000000001',
      merchantId: alipayConfig.sellerId,
      appId: alipayConfig.appId,
      amountMinor: 2901,
      currency: 'CNY',
      paidAt: new Date('2026-09-07T04:01:02.000Z'),
    });
  });

  test('rejects duplicate form fields even when the first value is valid', () => {
    const adapter = new AlipayPaymentAdapter(alipayConfig);
    const body = Buffer.concat([makeAlipayNotification(), Buffer.from('&total_amount=0.01')]);
    expect(() => adapter.verifyNotification(body, {})).toThrow();
  });

  test.each([
    ['seller identity', { seller_id: '2088000000000002' }],
    ['application identity', { app_id: '2026000000000002' }],
    ['fractional-fen amount', { total_amount: '29.001' }],
    ['negative amount', { total_amount: '-29.01' }],
    ['terminal state', { trade_status: 'TRADE_CLOSED' }],
  ])('rejects a signed notification with wrong %s', (_name, changes) => {
    const adapter = new AlipayPaymentAdapter(alipayConfig);
    expect(() => adapter.verifyNotification(makeAlipayNotification(changes), {})).toThrow();
  });

  test('returns null for an authenticated waiting notification', () => {
    const adapter = new AlipayPaymentAdapter(alipayConfig);
    const body = makeAlipayNotification({ trade_status: 'WAIT_BUYER_PAY' });
    expect(adapter.verifyNotification(body, {})).toBeNull();
  });

  test('rejects an authenticated waiting notification with malformed required payment fields', () => {
    const adapter = new AlipayPaymentAdapter(alipayConfig);
    const body = makeAlipayNotification({
      trade_status: 'WAIT_BUYER_PAY',
      total_amount: '',
    });
    expect(() => adapter.verifyNotification(body, {})).toThrow();
  });

  test('creates only an official Alipay page URL', async () => {
    const adapter = new AlipayPaymentAdapter(alipayConfig);
    const checkout = await adapter.create({
      orderNo: ORDER_NO,
      amountMinor: 2901,
      description: 'ViviAI credits',
      expiresAt: new Date('2026-09-07T04:15:00.000Z'),
    });
    expect(checkout.kind).toBe('redirect');
    const url = new URL(checkout.url);
    expect(url.origin).toBe('https://openapi.alipay.com');
    expect(url.pathname).toBe('/gateway.do');
    expect(url.searchParams.get('method')).toBe('alipay.trade.page.pay');
    expect(url.searchParams.get('sign_type')).toBe('RSA2');
  });

  test('rejects a page URL returned on a non-official domain', async () => {
    const sdk = makeAlipaySdkPort({
      pageExecute: () => 'https://openapi.alipay.com.evil.example/gateway.do',
    });
    const adapter = new AlipayPaymentAdapter(alipayConfig, sdk);
    await expect(
      adapter.create({
        orderNo: ORDER_NO,
        amountMinor: 2901,
        description: 'ViviAI credits',
        expiresAt: new Date('2026-09-07T04:15:00.000Z'),
      }),
    ).rejects.toThrow();
  });

  test('queries through SDK response verification before interpreting a paid result', async () => {
    const exec = vi.fn<AlipaySdkPort['exec']>(async (_method, _params, options) => {
      if (!options?.validateSign) throw new Error('unsigned response must not be interpreted');
      return {
        code: '10000',
        trade_status: 'TRADE_SUCCESS',
        out_trade_no: ORDER_NO,
        trade_no: '202609072200100000000001',
        total_amount: '29.01',
        buyer_pay_amount: '29.01',
        send_pay_date: '2026-09-07 12:01:02',
      };
    });
    const adapter = new AlipayPaymentAdapter(alipayConfig, makeAlipaySdkPort({ exec }));

    await expect(adapter.query(ORDER_NO)).resolves.toMatchObject({
      channel: 'alipay',
      eventId: 'alipay:query:202609072200100000000001',
      amountMinor: 2901,
    });
  });

  test('rejects an oversized verified Alipay query payload', async () => {
    const sdk = makeAlipaySdkPort({
      exec: async () => ({
        code: '10000',
        trade_status: 'TRADE_SUCCESS',
        out_trade_no: ORDER_NO,
        trade_no: '202609072200100000000001',
        total_amount: '29.01',
        send_pay_date: '2026-09-07 12:01:02',
        padding: 'x'.repeat(64 * 1024),
      }),
    });
    const adapter = new AlipayPaymentAdapter(alipayConfig, sdk);
    await expect(adapter.query(ORDER_NO)).rejects.toThrow();
  });
});

interface WechatNotification {
  body: Buffer;
  headers: Record<string, string>;
}

function makeWechatNotification(
  options: {
    timestamp?: number;
    payment?: Record<string, unknown>;
    eventType?: string;
  } = {},
): WechatNotification {
  const payment = { ...wechatPaidPayment(), ...options.payment };
  const resource = encryptWechatResource(payment);
  const body = Buffer.from(
    JSON.stringify({
      id: 'EVT_WECHAT_000001',
      create_time: '2026-09-07T12:00:00+08:00',
      resource_type: 'encrypt-resource',
      event_type: options.eventType ?? 'TRANSACTION.SUCCESS',
      summary: 'payment success',
      resource,
    }),
  );
  const timestamp = String(options.timestamp ?? NOW_SECONDS);
  const nonce = 'response-nonce-1';
  return {
    body,
    headers: {
      'wechatpay-timestamp': timestamp,
      'wechatpay-nonce': nonce,
      'wechatpay-serial': WECHAT_KEY_ID,
      'wechatpay-signature': signWechat(timestamp, nonce, body),
    },
  };
}

function wechatPaidPayment(): Record<string, unknown> {
  return {
    appid: wechatConfig.appId,
    mchid: wechatConfig.merchantId,
    out_trade_no: ORDER_NO,
    transaction_id: '420000000020260907000001',
    trade_type: 'NATIVE',
    trade_state: 'SUCCESS',
    success_time: '2026-09-07T03:58:00+00:00',
    amount: { total: 2900, payer_total: 2900, currency: 'CNY', payer_currency: 'CNY' },
  };
}

function encryptWechatResource(payment: Record<string, unknown>) {
  const nonce = Buffer.from('0123456789ab');
  const associatedData = Buffer.from('transaction');
  const cipher = createCipheriv('aes-256-gcm', API_V3_KEY, nonce);
  cipher.setAAD(associatedData);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payment), 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return {
    original_type: 'transaction',
    algorithm: 'AEAD_AES_256_GCM',
    ciphertext: ciphertext.toString('base64'),
    associated_data: associatedData.toString(),
    nonce: nonce.toString(),
  };
}

function signedWechatTransport(
  requests: PaymentHttpRequest[],
  responsePayload: (request: PaymentHttpRequest) => unknown,
  mutateAfterSigning = false,
): PaymentHttpTransport {
  return async (request) => {
    requests.push(request);
    const originalBody = Buffer.from(JSON.stringify(responsePayload(request)));
    const timestamp = String(NOW_SECONDS);
    const nonce = 'response-nonce-2';
    const response: PaymentHttpResponse = {
      status: 200,
      headers: {
        'wechatpay-timestamp': timestamp,
        'wechatpay-nonce': nonce,
        'wechatpay-serial': WECHAT_KEY_ID,
        'wechatpay-signature': signWechat(timestamp, nonce, originalBody),
      },
      body: mutateAfterSigning ? mutateByte(originalBody) : originalBody,
    };
    return response;
  };
}

function signWechat(timestamp: string, nonce: string, body: Buffer): string {
  return rsaSign(
    'RSA-SHA256',
    Buffer.concat([Buffer.from(`${timestamp}\n${nonce}\n`), body, Buffer.from('\n')]),
    wechatPrivateKey,
  ).toString('base64');
}

function expectWechatAuthorization(request: PaymentHttpRequest): void {
  const authorization = request.headers.authorization;
  const match =
    /^WECHATPAY2-SHA256-RSA2048 mchid="([^"]+)",nonce_str="([^"]+)",timestamp="([^"]+)",serial_no="([^"]+)",signature="([^"]+)"$/.exec(
      authorization ?? '',
    );
  expect(match).not.toBeNull();
  const [, merchantId, nonce, timestamp, serial, signature] = match!;
  expect({ merchantId, serial }).toEqual({
    merchantId: wechatConfig.merchantId,
    serial: wechatConfig.merchantSerial,
  });
  const url = new URL(request.url);
  const message = `${request.method}\n${url.pathname}${url.search}\n${timestamp}\n${nonce}\n${request.body!.toString()}\n`;
  expect(
    rsaVerify(
      'RSA-SHA256',
      Buffer.from(message),
      merchantKeys.publicKey,
      Buffer.from(signature!, 'base64'),
    ),
  ).toBe(true);
}

function mutateByte(input: Buffer): Buffer {
  const result = Buffer.from(input);
  result[result.length - 2] = result[result.length - 2]! ^ 1;
  return result;
}

const rejectingTransport: PaymentHttpTransport = async () => {
  throw new Error('unexpected network request');
};

function makeAlipayNotification(changes: Record<string, string> = {}): Buffer {
  const fields: Record<string, string> = {
    notify_time: '2026-09-07 12:01:03',
    notify_type: 'trade_status_sync',
    notify_id: '202609070000000000000001',
    app_id: alipayConfig.appId,
    charset: 'utf-8',
    version: '1.0',
    sign_type: 'RSA2',
    trade_no: '202609072200100000000001',
    out_trade_no: ORDER_NO,
    seller_id: alipayConfig.sellerId,
    trade_status: 'TRADE_SUCCESS',
    total_amount: '29.01',
    receipt_amount: '29.01',
    buyer_pay_amount: '29.01',
    gmt_payment: '2026-09-07 12:01:02',
    ...changes,
  };
  const canonical = Object.entries(fields)
    .filter(([key]) => key !== 'sign' && key !== 'sign_type')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  fields.sign = rsaSign('RSA-SHA256', Buffer.from(canonical), alipayKeys.privateKey).toString(
    'base64',
  );
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) params.set(key, value);
  return Buffer.from(params.toString());
}

function makeAlipaySdkPort(overrides: Partial<AlipaySdkPort>): AlipaySdkPort {
  return {
    pageExecute: () => 'https://openapi.alipay.com/gateway.do',
    exec: async () => ({ code: '40004', trade_status: 'WAIT_BUYER_PAY' }),
    checkNotifySignV2: () => false,
    ...overrides,
  };
}
