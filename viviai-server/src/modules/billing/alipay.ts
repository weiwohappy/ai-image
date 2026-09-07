import { createPrivateKey, createPublicKey } from 'node:crypto';
import { AlipaySdk } from 'alipay-sdk';
import type { Checkout, PaidFact, PaymentAdapter, PaymentRequest } from './contracts.js';
import {
  PAYMENT_MAX_RESPONSE_BYTES,
  PAYMENT_TIMEOUT_MS,
  PaymentProtocolError,
  defaultPaymentHttpTransport,
  decodeUtf8,
  parseCnyDecimal,
  parseJsonObject,
  requireFiniteDate,
  requireObject,
  requireString,
  validatePaymentRequest,
  type PaymentHttpResponse,
  type PaymentHttpTransport,
} from './payment-security.js';

const ALIPAY_GATEWAY = 'https://openapi.alipay.com/gateway.do';

export interface AlipayPaymentConfig {
  appId: string;
  sellerId: string;
  privateKey: string | Buffer;
  alipayPublicKey: string | Buffer;
  notifyUrl: string;
  returnUrl: string;
}

export interface AlipaySdkPort {
  pageExecute(method: string, httpMethod: string, params: Record<string, unknown>): string;
  sdkExecute(
    method: string,
    params: Record<string, unknown>,
    options?: { bizContentAutoSnakeCase?: boolean },
  ): string;
  checkResponseSign(
    responseDataRaw: string,
    responseKey: string,
    serverSign: string,
    traceId: string,
  ): void;
  checkNotifySignV2(postData: Record<string, string>): boolean;
}

export class AlipayPaymentAdapter implements PaymentAdapter {
  readonly channel = 'alipay' as const;
  readonly merchantId: string;
  readonly appId: string;
  private readonly notifyUrl: string;
  private readonly returnUrl: string;
  private readonly sdk: AlipaySdkPort;

  constructor(
    config: AlipayPaymentConfig,
    sdk?: AlipaySdkPort,
    private readonly transport: PaymentHttpTransport = defaultPaymentHttpTransport,
  ) {
    this.appId = requireDigits(config.appId, 'appId');
    this.merchantId = requireDigits(config.sellerId, 'sellerId');
    this.notifyUrl = requireHttpsUrl(config.notifyUrl, 'notifyUrl');
    this.returnUrl = requireHttpsUrl(config.returnUrl, 'returnUrl');
    const privateKey = requireRsaPrivateKey(config.privateKey);
    const publicKey = requireRsaPublicKey(config.alipayPublicKey);
    this.sdk =
      sdk ??
      (new AlipaySdk({
        appId: this.appId,
        privateKey,
        alipayPublicKey: publicKey,
        signType: 'RSA2',
        keyType: 'PKCS8',
        gateway: ALIPAY_GATEWAY,
        timeout: 10_000,
        camelcase: false,
      }) as unknown as AlipaySdkPort);
  }

  async create(input: PaymentRequest): Promise<Checkout> {
    validatePaymentRequest(input);
    requireFiniteDate(input.expiresAt, 'expiresAt');
    const url = this.sdk.pageExecute('alipay.trade.page.pay', 'GET', {
      notifyUrl: this.notifyUrl,
      returnUrl: this.returnUrl,
      bizContent: {
        out_trade_no: input.orderNo,
        product_code: 'FAST_INSTANT_TRADE_PAY',
        total_amount: formatCny(input.amountMinor),
        subject: input.description,
        seller_id: this.merchantId,
        time_expire: formatAlipayDate(input.expiresAt),
      },
    });
    if (Buffer.byteLength(url) > PAYMENT_MAX_RESPONSE_BYTES) {
      throw new PaymentProtocolError('Alipay checkout response exceeded the size limit');
    }
    validateAlipayCheckoutUrl(url);
    return { kind: 'redirect', url };
  }

  async query(orderNo: string): Promise<PaidFact | null> {
    validateOrderNo(orderNo);
    const requestBody = Buffer.from(
      this.sdk.sdkExecute('alipay.trade.query', {
        bizContent: { out_trade_no: orderNo },
      }),
    );
    if (requestBody.length > PAYMENT_MAX_RESPONSE_BYTES) {
      throw new PaymentProtocolError('Alipay query request exceeded the size limit');
    }
    const httpResponse = await this.transport({
      method: 'POST',
      url: ALIPAY_GATEWAY,
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: requestBody,
      timeoutMs: PAYMENT_TIMEOUT_MS,
      maxResponseBytes: PAYMENT_MAX_RESPONSE_BYTES,
      followRedirects: false,
    });
    const response = this.acceptQueryResponse(httpResponse);
    if (response.code !== '10000') {
      throw new PaymentProtocolError('Alipay query was not successful');
    }
    const responseOrderNo = requireString(response, 'out_trade_no', 64);
    validateOrderNo(responseOrderNo);
    if (responseOrderNo !== orderNo) {
      throw new PaymentProtocolError('Alipay query returned a different order');
    }
    const status = requireString(response, 'trade_status', 32);
    if (status === 'WAIT_BUYER_PAY') return null;
    if (!['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(status)) {
      throw new PaymentProtocolError('Alipay trade state is not payable');
    }
    const tradeNo = requireString(response, 'trade_no', 64);
    return this.normalizePaid(response, `alipay:query:${tradeNo}`, 'send_pay_date');
  }

  private acceptQueryResponse(response: PaymentHttpResponse): Record<string, unknown> {
    if (response.body.length === 0 || response.body.length > PAYMENT_MAX_RESPONSE_BYTES) {
      throw new PaymentProtocolError('Alipay query response body is invalid');
    }
    const rawBody = decodeUtf8(response.body);
    const envelope = parseJsonObject(response.body);
    const responseKey = 'alipay_trade_query_response';
    if (!Object.hasOwn(envelope, responseKey)) {
      throw new PaymentProtocolError('Alipay query response envelope is invalid');
    }
    const serverSign = requireString(envelope, 'sign', 1024);
    try {
      this.sdk.checkResponseSign(rawBody, responseKey, serverSign, 'payment-query');
    } catch {
      throw new PaymentProtocolError('Alipay query response signature is invalid');
    }
    if (response.status < 200 || response.status >= 300) {
      throw new PaymentProtocolError(`Alipay query failed with status ${response.status}`);
    }
    return requireObject(envelope[responseKey], responseKey);
  }

  verifyNotification(
    rawBody: Buffer,
    _headers: Record<string, string | string[] | undefined>,
  ): PaidFact | null {
    if (
      !Buffer.isBuffer(rawBody) ||
      rawBody.length === 0 ||
      rawBody.length > PAYMENT_MAX_RESPONSE_BYTES
    ) {
      throw new PaymentProtocolError('Alipay notification body is invalid');
    }
    const params = new URLSearchParams(decodeUtf8(rawBody));
    const fields = Object.create(null) as Record<string, string>;
    const seenFields = new Set<string>();
    for (const [key, value] of params) {
      if (key.length === 0 || key.length > 64 || seenFields.has(key)) {
        throw new PaymentProtocolError('Alipay notification contains duplicate or invalid fields');
      }
      seenFields.add(key);
      fields[key] = value;
    }
    if (requireFormField(fields, 'sign_type', 8) !== 'RSA2') {
      throw new PaymentProtocolError('Alipay sign_type is invalid');
    }
    requireFormField(fields, 'sign', 1024);
    if (!this.sdk.checkNotifySignV2(fields)) {
      throw new PaymentProtocolError('Alipay signature is invalid');
    }
    const appId = requireFormField(fields, 'app_id', 32);
    const sellerId = requireFormField(fields, 'seller_id', 32);
    if (appId !== this.appId || sellerId !== this.merchantId) {
      throw new PaymentProtocolError('Alipay merchant identity does not match');
    }
    const eventId = requireFormField(fields, 'notify_id', 128);
    validateOrderNo(requireFormField(fields, 'out_trade_no', 64));
    requireFormField(fields, 'trade_no', 64);
    parseCnyDecimal(requireFormField(fields, 'total_amount', 32));
    const status = requireFormField(fields, 'trade_status', 32);
    if (status === 'WAIT_BUYER_PAY') return null;
    if (!['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(status)) {
      throw new PaymentProtocolError('Alipay trade state is not payable');
    }
    return this.normalizePaid(fields, eventId, 'gmt_payment');
  }

  private normalizePaid(
    fields: Record<string, unknown>,
    eventId: string,
    paidTimeField: string,
  ): PaidFact {
    const orderNo = requireString(fields, 'out_trade_no', 64);
    validateOrderNo(orderNo);
    const tradeNo = requireString(fields, 'trade_no', 64);
    const amountText = requireString(fields, 'total_amount', 32);
    const paidAt = parseAlipayDate(requireString(fields, paidTimeField, 19), paidTimeField);
    return {
      channel: this.channel,
      eventId,
      orderNo,
      tradeNo,
      merchantId: this.merchantId,
      appId: this.appId,
      amountMinor: parseCnyDecimal(amountText),
      currency: 'CNY',
      paidAt,
    };
  }
}

function requireFormField(fields: Record<string, string>, name: string, maxLength: number): string {
  const value = fields[name];
  if (value === undefined || value.length === 0 || value.length > maxLength) {
    throw new PaymentProtocolError(`${name} is invalid`);
  }
  return value;
}

function requireDigits(value: string, field: string): string {
  if (!/^\d{10,32}$/.test(value)) throw new PaymentProtocolError(`${field} is invalid`);
  return value;
}

function requireRsaPrivateKey(value: string | Buffer): string {
  try {
    const key = createPrivateKey(value.toString());
    if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
      throw new Error('not an RSA-2048 key');
    }
    return key.export({ format: 'pem', type: 'pkcs8' }).toString();
  } catch {
    throw new PaymentProtocolError('Alipay private key is invalid');
  }
}

function requireRsaPublicKey(value: string | Buffer): string {
  try {
    const key = createPublicKey(value.toString());
    if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
      throw new Error('not an RSA-2048 key');
    }
    return key.export({ format: 'pem', type: 'spki' }).toString();
  } catch {
    throw new PaymentProtocolError('Alipay public key is invalid');
  }
}

function validateOrderNo(value: string): void {
  if (!/^[0-9A-Za-z_\-|*]{6,64}$/.test(value)) throw new PaymentProtocolError('orderNo is invalid');
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

function formatCny(amountMinor: number): string {
  return `${Math.floor(amountMinor / 100)}.${String(amountMinor % 100).padStart(2, '0')}`;
}

function formatAlipayDate(value: Date): string {
  const shifted = new Date(value.getTime() + 8 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 19).replace('T', ' ');
}

function parseAlipayDate(value: string, field: string): Date {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    throw new PaymentProtocolError(`${field} is invalid`);
  }
  const result = new Date(`${value.replace(' ', 'T')}+08:00`);
  if (!Number.isFinite(result.getTime())) throw new PaymentProtocolError(`${field} is invalid`);
  return result;
}

function validateAlipayCheckoutUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PaymentProtocolError('Alipay checkout URL is invalid');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'openapi.alipay.com' ||
    url.port !== '' ||
    url.pathname !== '/gateway.do' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    url.searchParams.get('method') !== 'alipay.trade.page.pay' ||
    url.searchParams.get('sign_type') !== 'RSA2'
  ) {
    throw new PaymentProtocolError('Alipay checkout URL is invalid');
  }
}
