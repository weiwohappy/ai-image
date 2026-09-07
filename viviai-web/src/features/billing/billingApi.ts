export type Channel = 'wechat' | 'alipay';
export interface CreditPack {
  id: string;
  name: string;
  amountMinor: number;
  credits: number;
  durationDays: number;
}
export interface Catalog {
  enabled: boolean;
  plans: CreditPack[];
  channels: { channel: Channel; enabled: boolean }[];
}
export interface BillingAccount {
  id: string;
  email: string;
  credits: number;
}
export interface PaymentOrder extends CreditPack {
  planId: string;
  orderNo: string;
  channel: Channel;
  currency: 'CNY';
  status: 'creating' | 'pending' | 'paid' | 'expired';
  checkout: { kind: 'qr' | 'redirect'; url: string } | null;
  expiresAt: string;
  fulfilledAt: string | null;
}
export class BillingError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('Content-Type', 'application/json');
  const response = await fetch(
    new URL('/api/billing' + path, window.location.origin),
    {
      ...init,
      credentials: 'same-origin',
      signal: AbortSignal.timeout(15_000),
      headers,
    },
  );
  if (!response.headers.get('content-type')?.includes('application/json'))
    throw new BillingError('支付服务尚未连接，请稍后重试。', response.status);
  const body = (await response.json()) as { data?: unknown; message?: string };
  if (!response.ok)
    throw new BillingError(
      response.status === 401
        ? '请先登录真实账户。'
        : (body.message ?? '支付服务暂时不可用。'),
      response.status,
    );
  return body.data as T;
}
export function validateCheckout(order: PaymentOrder): PaymentOrder {
  if (!order.checkout) return order;
  try {
    const url = new URL(order.checkout.url);
    const valid =
      order.channel === 'wechat'
        ? order.checkout.kind === 'qr' &&
          url.protocol === 'weixin:' &&
          url.hostname === 'wxpay' &&
          url.pathname === '/bizpayurl'
        : order.checkout.kind === 'redirect' &&
          url.origin === 'https://openapi.alipay.com' &&
          url.pathname === '/gateway.do';
    if (!valid || url.username || url.password || url.hash) throw new Error();
  } catch {
    throw new BillingError('支付链接无效，请查询原订单或联系支持。', 502);
  }
  return order;
}
export const billingApi = {
  catalog: () => request<Catalog>('/catalog'),
  me: () => request<BillingAccount>('/me'),
  login: (account: string, password: string) =>
    request<BillingAccount>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ account, password }),
    }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  create: async (planId: string, channel: Channel, key: string) =>
    validateCheckout(
      await request<PaymentOrder>('/orders', {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body: JSON.stringify({ planId, channel }),
      }),
    ),
  order: async (id: string) =>
    validateCheckout(
      await request<PaymentOrder>('/orders/' + encodeURIComponent(id)),
    ),
  sync: async (id: string) =>
    validateCheckout(
      await request<PaymentOrder>(
        '/orders/' + encodeURIComponent(id) + '/sync',
        { method: 'POST' },
      ),
    ),
};
export const money = (amountMinor: number) =>
  '¥' + (amountMinor / 100).toFixed(2);
export const accountKey = ['billing', 'me'] as const;
