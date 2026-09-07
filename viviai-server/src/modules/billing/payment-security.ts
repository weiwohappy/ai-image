import { TextDecoder } from 'node:util';

export const PAYMENT_TIMEOUT_MS = 10_000;
export const PAYMENT_MAX_RESPONSE_BYTES = 64 * 1024;

export class PaymentProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentProtocolError';
  }
}

export interface PaymentHttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: Buffer;
  timeoutMs: number;
  maxResponseBytes: number;
  followRedirects: boolean;
}

export interface PaymentHttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export type PaymentHttpTransport = (request: PaymentHttpRequest) => Promise<PaymentHttpResponse>;

export const defaultPaymentHttpTransport: PaymentHttpTransport = async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    ...(request.body === undefined ? {} : { body: request.body.toString('utf8') }),
    redirect: request.followRedirects ? 'follow' : 'error',
    signal: AbortSignal.timeout(request.timeoutMs),
  });
  const length = response.headers.get('content-length');
  if (length !== null && Number(length) > request.maxResponseBytes) {
    throw new PaymentProtocolError('Payment response exceeded the size limit');
  }
  const body = await readBoundedBody(response, request.maxResponseBytes);
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body,
  };
};

async function readBoundedBody(response: Response, limit: number): Promise<Buffer> {
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    total += item.value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new PaymentProtocolError('Payment response exceeded the size limit');
    }
    chunks.push(Buffer.from(item.value));
  }
  return Buffer.concat(chunks, total);
}

export function getSingleHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string {
  const target = name.toLowerCase();
  const matches = Object.entries(headers).filter(([key]) => key.toLowerCase() === target);
  if (matches.length !== 1) throw new PaymentProtocolError(`Missing or duplicate ${name} header`);
  const value = matches[0]![1];
  if (typeof value !== 'string' || value.length === 0) {
    throw new PaymentProtocolError(`Invalid ${name} header`);
  }
  return value;
}

export function decodeUtf8(value: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    throw new PaymentProtocolError('Payment payload is not valid UTF-8');
  }
}

export function parseJsonObject(value: Buffer): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(value));
  } catch (error) {
    if (error instanceof PaymentProtocolError) throw error;
    throw new PaymentProtocolError('Payment payload is not valid JSON');
  }
  return requireObject(parsed, 'payment payload');
}

export function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PaymentProtocolError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function requireString(
  object: Record<string, unknown>,
  field: string,
  maxLength: number,
): string {
  const value = object[field];
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new PaymentProtocolError(`${field} is invalid`);
  }
  return value;
}

export function requireInteger(
  object: Record<string, unknown>,
  field: string,
  minimum = 1,
): number {
  const value = object[field];
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new PaymentProtocolError(`${field} is invalid`);
  }
  return value as number;
}

export function requireFiniteDate(value: Date, field: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new PaymentProtocolError(`${field} is invalid`);
  }
  return value;
}

export function requireRfc3339(value: string, field: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new PaymentProtocolError(`${field} is invalid`);
  }
  const result = new Date(value);
  if (!Number.isFinite(result.getTime())) throw new PaymentProtocolError(`${field} is invalid`);
  return result;
}

export function parseCnyDecimal(value: string): number {
  const match = /^(0|[1-9]\d{0,15})(?:\.(\d{1,2}))?$/.exec(value);
  if (match === null) throw new PaymentProtocolError('CNY amount is invalid');
  const yuan = BigInt(match[1]!);
  const fraction = (match[2] ?? '').padEnd(2, '0');
  const exact = yuan * 100n + BigInt(fraction || '0');
  if (exact <= 0n || exact > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new PaymentProtocolError('CNY amount is invalid');
  }
  return Number(exact);
}

export function validatePaymentRequest(input: {
  orderNo: string;
  amountMinor: number;
  description: string;
  expiresAt: Date;
}): void {
  if (!/^[0-9A-Za-z_\-|*]{6,32}$/.test(input.orderNo)) {
    throw new PaymentProtocolError('orderNo is invalid');
  }
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new PaymentProtocolError('amountMinor is invalid');
  }
  if (input.description.length < 1 || input.description.length > 127) {
    throw new PaymentProtocolError('description is invalid');
  }
  requireFiniteDate(input.expiresAt, 'expiresAt');
}
