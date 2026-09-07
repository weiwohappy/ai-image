export type PaymentChannel = 'wechat' | 'alipay';

export type Checkout = { kind: 'qr' | 'redirect'; url: string };

export type PaymentRequest = {
  orderNo: string;
  amountMinor: number;
  description: string;
  expiresAt: Date;
};

export type PaidFact = {
  channel: PaymentChannel;
  eventId: string;
  orderNo: string;
  tradeNo: string;
  merchantId: string;
  appId: string;
  amountMinor: number;
  currency: 'CNY';
  paidAt: Date;
};

export interface PaymentAdapter {
  readonly channel: PaymentChannel;
  readonly merchantId: string;
  readonly appId: string;
  create(input: PaymentRequest): Promise<Checkout>;
  query(orderNo: string): Promise<PaidFact | null>;
  verifyNotification(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): PaidFact | null;
}
