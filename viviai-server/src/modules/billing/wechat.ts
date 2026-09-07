import {
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign as rsaSign,
  verify as rsaVerify,
  type KeyObject,
} from 'node:crypto';
import type { Checkout, PaidFact, PaymentAdapter, PaymentRequest } from './contracts.js';
import {
  PAYMENT_MAX_RESPONSE_BYTES,
  PAYMENT_TIMEOUT_MS,
  PaymentProtocolError,
  defaultPaymentHttpTransport,
  getSingleHeader,
  parseJsonObject,
  requireFiniteDate,
  requireInteger,
  requireObject,
  requireRfc3339,
  requireString,
  validatePaymentRequest,
  type PaymentHttpResponse,
  type PaymentHttpTransport,
} from './payment-security.js';

const WECHAT_API_ORIGIN = 'https://api.mch.weixin.qq.com';
const MAX_CLOCK_SKEW_SECONDS = 300;

export interface WechatPaymentConfig {
  merchantId: string;
  appId: string;
  merchantSerial: string;
  merchantPrivateKey: string | Buffer;
  apiV3Key: string | Buffer;
  platformPublicKeys: Record<string, string | Buffer>;
  notifyUrl: string;
  now?: () => Date;
}

export class WechatPaymentAdapter implements PaymentAdapter {
  readonly channel = 'wechat' as const;
  readonly merchantId: string;
  readonly appId: string;
  private readonly merchantSerial: string;
  private readonly merchantPrivateKey: KeyObject;
  private readonly apiV3Key: Buffer;
  private readonly platformPublicKeys: ReadonlyMap<string, KeyObject>;
  private readonly notifyUrl: string;
  private readonly now: () => Date;

  constructor(
    config: WechatPaymentConfig,
    private readonly transport: PaymentHttpTransport = defaultPaymentHttpTransport,
  ) {
    this.merchantId = boundedIdentity(config.merchantId, 'merchantId');
    this.appId = boundedIdentity(config.appId, 'appId');
    if (!/^[0-9A-F]{8,64}$/i.test(config.merchantSerial)) {
      throw new PaymentProtocolError('merchantSerial is invalid');
    }
    this.merchantSerial = config.merchantSerial;
    this.merchantPrivateKey = createPrivateKey(config.merchantPrivateKey);
    this.apiV3Key = Buffer.from(config.apiV3Key);
    if (this.apiV3Key.length !== 32) throw new PaymentProtocolError('apiV3Key must be 32 bytes');
    const publicKeys = Object.entries(config.platformPublicKeys);
    if (publicKeys.length === 0)
      throw new PaymentProtocolError('A WeChat Pay public key is required');
    this.platformPublicKeys = new Map(
      publicKeys.map(([keyId, publicKey]) => {
        if (!/^PUB_KEY_ID_\d{10,64}$/.test(keyId)) {
          throw new PaymentProtocolError('WeChat Pay public key ID is invalid');
        }
        return [keyId, createPublicKey(publicKey)];
      }),
    );
    this.notifyUrl = requireHttpsUrl(config.notifyUrl, 'notifyUrl');
    this.now = config.now ?? (() => new Date());
    requireFiniteDate(this.now(), 'now');
  }

  async create(input: PaymentRequest): Promise<Checkout> {
    validatePaymentRequest(input);
    if (input.expiresAt.getTime() <= this.currentTime().getTime()) {
      throw new PaymentProtocolError('expiresAt must be in the future');
    }
    const body = Buffer.from(
      JSON.stringify({
        appid: this.appId,
        mchid: this.merchantId,
        description: input.description,
        out_trade_no: input.orderNo,
        time_expire: formatChinaRfc3339(input.expiresAt),
        notify_url: this.notifyUrl,
        amount: { total: input.amountMinor, currency: 'CNY' },
      }),
    );
    const response = await this.request('POST', '/v3/pay/transactions/native', body);
    const payload = this.acceptResponse(response);
    const codeUrl = requireString(payload, 'code_url', 512);
    if (!/^weixin:\/\/wxpay\/bizpayurl\?[A-Za-z0-9._~!$&'()*+,;=:@/?%-]+$/.test(codeUrl)) {
      throw new PaymentProtocolError('WeChat checkout URL is invalid');
    }
    return { kind: 'qr', url: codeUrl };
  }

  async query(orderNo: string): Promise<PaidFact | null> {
    validateOrderNo(orderNo);
    const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderNo)}?mchid=${encodeURIComponent(this.merchantId)}`;
    const response = await this.request('GET', path);
    const payment = this.acceptResponse(response);
    return this.normalizePayment(payment, `wechat:query:${String(payment.transaction_id ?? '')}`);
  }

  verifyNotification(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): PaidFact | null {
    if (
      !Buffer.isBuffer(rawBody) ||
      rawBody.length === 0 ||
      rawBody.length > PAYMENT_MAX_RESPONSE_BYTES
    ) {
      throw new PaymentProtocolError('WeChat notification body is invalid');
    }
    this.verifyWechatSignature(rawBody, headers);
    const envelope = parseJsonObject(rawBody);
    const eventId = requireString(envelope, 'id', 64);
    requireRfc3339(requireString(envelope, 'create_time', 64), 'create_time');
    if (requireString(envelope, 'resource_type', 32) !== 'encrypt-resource') {
      throw new PaymentProtocolError('WeChat resource_type is invalid');
    }
    const eventType = requireString(envelope, 'event_type', 32);
    const resource = requireObject(envelope.resource, 'resource');
    const payment = this.decryptResource(resource);
    if (eventType !== 'TRANSACTION.SUCCESS') {
      throw new PaymentProtocolError('WeChat event type is invalid');
    }
    return this.normalizePayment(payment, eventId);
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: Buffer,
  ): Promise<PaymentHttpResponse> {
    const timestamp = String(Math.floor(this.currentTime().getTime() / 1000));
    const nonce = randomBytes(16).toString('hex');
    const message = `${method}\n${path}\n${timestamp}\n${nonce}\n${body?.toString() ?? ''}\n`;
    const signature = rsaSign('RSA-SHA256', Buffer.from(message), this.merchantPrivateKey).toString(
      'base64',
    );
    return this.transport({
      method,
      url: `${WECHAT_API_ORIGIN}${path}`,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        authorization: `WECHATPAY2-SHA256-RSA2048 mchid="${this.merchantId}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${this.merchantSerial}",signature="${signature}"`,
      },
      ...(body === undefined ? {} : { body }),
      timeoutMs: PAYMENT_TIMEOUT_MS,
      maxResponseBytes: PAYMENT_MAX_RESPONSE_BYTES,
      followRedirects: false,
    });
  }

  private acceptResponse(response: PaymentHttpResponse): Record<string, unknown> {
    if (response.body.length > PAYMENT_MAX_RESPONSE_BYTES) {
      throw new PaymentProtocolError('WeChat response exceeded the size limit');
    }
    this.verifyWechatSignature(response.body, response.headers);
    if (response.status < 200 || response.status >= 300) {
      throw new PaymentProtocolError(`WeChat request failed with status ${response.status}`);
    }
    return parseJsonObject(response.body);
  }

  private verifyWechatSignature(
    body: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): void {
    const timestamp = getSingleHeader(headers, 'wechatpay-timestamp');
    if (!/^\d{10}$/.test(timestamp)) throw new PaymentProtocolError('WeChat timestamp is invalid');
    const timestampNumber = Number(timestamp);
    if (
      Math.abs(timestampNumber - Math.floor(this.currentTime().getTime() / 1000)) >
      MAX_CLOCK_SKEW_SECONDS
    ) {
      throw new PaymentProtocolError('WeChat signature timestamp is stale');
    }
    const nonce = getSingleHeader(headers, 'wechatpay-nonce');
    if (nonce.length > 64) throw new PaymentProtocolError('WeChat nonce is invalid');
    const serial = getSingleHeader(headers, 'wechatpay-serial');
    const publicKey = this.platformPublicKeys.get(serial);
    if (publicKey === undefined) throw new PaymentProtocolError('Unknown WeChat Pay public key ID');
    const signature = getSingleHeader(headers, 'wechatpay-signature');
    if (signature.startsWith('WECHATPAY/SIGNTEST/')) {
      throw new PaymentProtocolError('WeChat signature is invalid');
    }
    const message = Buffer.concat([
      Buffer.from(`${timestamp}\n${nonce}\n`),
      body,
      Buffer.from('\n'),
    ]);
    let valid = false;
    try {
      valid = rsaVerify('RSA-SHA256', message, publicKey, Buffer.from(signature, 'base64'));
    } catch {
      valid = false;
    }
    if (!valid) throw new PaymentProtocolError('WeChat signature is invalid');
  }

  private decryptResource(resource: Record<string, unknown>): Record<string, unknown> {
    if (requireString(resource, 'algorithm', 32) !== 'AEAD_AES_256_GCM') {
      throw new PaymentProtocolError('WeChat encryption algorithm is invalid');
    }
    if (requireString(resource, 'original_type', 16) !== 'transaction') {
      throw new PaymentProtocolError('WeChat resource type is invalid');
    }
    const nonce = requireString(resource, 'nonce', 16);
    if (Buffer.byteLength(nonce) !== 12) throw new PaymentProtocolError('WeChat nonce is invalid');
    const associatedDataValue = resource.associated_data;
    if (typeof associatedDataValue !== 'string' || associatedDataValue.length > 16) {
      throw new PaymentProtocolError('WeChat associated data is invalid');
    }
    const ciphertextText = requireString(resource, 'ciphertext', PAYMENT_MAX_RESPONSE_BYTES);
    const ciphertext = Buffer.from(ciphertextText, 'base64');
    if (ciphertext.length < 17 || ciphertext.toString('base64') !== ciphertextText) {
      throw new PaymentProtocolError('WeChat ciphertext is invalid');
    }
    const authTag = ciphertext.subarray(ciphertext.length - 16);
    const encrypted = ciphertext.subarray(0, ciphertext.length - 16);
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.apiV3Key, Buffer.from(nonce));
      decipher.setAAD(Buffer.from(associatedDataValue));
      decipher.setAuthTag(authTag);
      return parseJsonObject(Buffer.concat([decipher.update(encrypted), decipher.final()]));
    } catch (error) {
      if (error instanceof PaymentProtocolError) throw error;
      throw new PaymentProtocolError('WeChat encrypted resource is invalid');
    }
  }

  private normalizePayment(payment: Record<string, unknown>, eventId: string): PaidFact | null {
    const appId = requireString(payment, 'appid', 32);
    const merchantId = requireString(payment, 'mchid', 32);
    if (appId !== this.appId || merchantId !== this.merchantId) {
      throw new PaymentProtocolError('WeChat merchant identity does not match');
    }
    const orderNo = requireString(payment, 'out_trade_no', 32);
    validateOrderNo(orderNo);
    const tradeState = requireString(payment, 'trade_state', 32);
    if (tradeState !== 'SUCCESS') {
      if (['NOTPAY', 'USERPAYING'].includes(tradeState)) return null;
      throw new PaymentProtocolError('WeChat trade state is not payable');
    }
    const tradeNo = requireString(payment, 'transaction_id', 32);
    const amount = requireObject(payment.amount, 'amount');
    const amountMinor = requireInteger(amount, 'total');
    if (requireString(amount, 'currency', 16) !== 'CNY') {
      throw new PaymentProtocolError('WeChat currency is invalid');
    }
    const paidAt = requireRfc3339(requireString(payment, 'success_time', 64), 'success_time');
    if (eventId.endsWith(':')) throw new PaymentProtocolError('WeChat event ID is invalid');
    return {
      channel: this.channel,
      eventId,
      orderNo,
      tradeNo,
      merchantId,
      appId,
      amountMinor,
      currency: 'CNY',
      paidAt,
    };
  }

  private currentTime(): Date {
    return requireFiniteDate(this.now(), 'now');
  }
}

function validateOrderNo(value: string): void {
  if (!/^[0-9A-Za-z_\-|*]{6,32}$/.test(value)) throw new PaymentProtocolError('orderNo is invalid');
}

function boundedIdentity(value: string, field: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 32) {
    throw new PaymentProtocolError(`${field} is invalid`);
  }
  return value;
}

function requireHttpsUrl(value: string, field: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PaymentProtocolError(`${field} is invalid`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new PaymentProtocolError(`${field} is invalid`);
  }
  return url.toString();
}

function formatChinaRfc3339(date: Date): string {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return `${shifted.toISOString().slice(0, 19)}+08:00`;
}
