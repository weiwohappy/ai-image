import { AlipaySdk } from 'alipay-sdk';
import type { Checkout, PaidFact, PaymentAdapter, PaymentRequest } from './contracts.js';
import {
  PAYMENT_MAX_RESPONSE_BYTES,
  PaymentProtocolError,
  decodeUtf8,
  parseCnyDecimal,
  requireFiniteDate,
  requireString,
  validatePaymentRequest,
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
  exec(
    method: string,
    params: Record<string, unknown>,
    options?: { validateSign?: boolean },
  ): Promise<Record<string, unknown>>;
  checkNotifySignV2(postData: Record<string, string>): boolean;
}

export class AlipayPaymentAdapter implements PaymentAdapter {
  readonly channel = 'alipay' as const;
  readonly merchantId: string;
  readonly appId: string;
  private readonly notifyUrl: string;
  private readonly returnUrl: string;
  private readonly sdk: AlipaySdkPort;

  constructor(config: AlipayPaymentConfig, sdk?: AlipaySdkPort) {
    this.appId = requireDigits(config.appId, 'appId');
    this.merchantId = requireDigits(config.sellerId, 'sellerId');
    this.notifyUrl = requireHttpsUrl(config.notifyUrl, 'notifyUrl');
    this.returnUrl = requireHttpsUrl(config.returnUrl, 'returnUrl');
    this.sdk =
      sdk ??
      (new AlipaySdk({
        appId: this.appId,
        privateKey: config.privateKey.toString(),
        alipayPublicKey: config.alipayPublicKey.toString(),
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
    const response = await this.sdk.exec(
      'alipay.trade.query',
      { bizContent: { out_trade_no: orderNo } },
      { validateSign: true },
    );
    assertBoundedObject(response);
    if (response.code !== '10000') {
      throw new PaymentProtocolError('Alipay query was not successful');
    }
    const status = requireString(response, 'trade_status', 32);
    if (status === 'WAIT_BUYER_PAY') return null;
    if (!['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(status)) {
      throw new PaymentProtocolError('Alipay trade state is not payable');
    }
    const tradeNo = requireString(response, 'trade_no', 64);
    return this.normalizePaid(response, `alipay:query:${tradeNo}`, 'send_pay_date');
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
    const fields: Record<string, string> = {};
    for (const [key, value] of params) {
      if (key.length === 0 || key.length > 64 || Object.hasOwn(fields, key)) {
        throw new PaymentProtocolError('Alipay notification contains duplicate or invalid fields');
      }
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

function assertBoundedObject(value: Record<string, unknown>): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new PaymentProtocolError('Alipay response is malformed');
  }
  if (Buffer.byteLength(serialized) > PAYMENT_MAX_RESPONSE_BYTES) {
    throw new PaymentProtocolError('Alipay response exceeded the size limit');
  }
}
