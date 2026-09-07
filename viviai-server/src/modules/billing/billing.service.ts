import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService } from '../../shared/database/database.service.js';
import { lockWallet } from '../../shared/database/locks.js';
import { WalletService } from '../wallet/wallet.service.js';
import { AppError } from '../../shared/http/errors.js';
import type { PaymentOrder } from '../../generated/prisma/client.js';
import type { Checkout, PaidFact, PaymentAdapter } from './contracts.js';

export const BILLING_RUNTIME = Symbol('BILLING_RUNTIME');
export interface BillingPlan {
  id: string;
  name: string;
  amountMinor: number;
  credits: number;
  durationDays: number;
}
export interface BillingRuntime {
  enabled: boolean;
  plans: BillingPlan[];
  adapters: PaymentAdapter[];
}
const inputSchema = z
  .object({ planId: z.string().min(1).max(80), channel: z.enum(['wechat', 'alipay']) })
  .strict();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function safeCheckout(value: Checkout, channel: string): Checkout {
  const url = new URL(value.url);
  const valid =
    channel === 'wechat'
      ? value.kind === 'qr' &&
        url.protocol === 'weixin:' &&
        url.hostname === 'wxpay' &&
        url.pathname === '/bizpayurl'
      : value.kind === 'redirect' &&
        url.origin === 'https://openapi.alipay.com' &&
        url.pathname === '/gateway.do';
  if (!valid || url.username || url.password || value.url.length > 16384)
    throw new AppError(502, 'INVALID_CHECKOUT', 'Payment checkout is invalid');
  return value;
}
function dto(order: PaymentOrder) {
  const expired = order.status !== 'paid' && order.expiresAt.getTime() <= Date.now();
  return {
    id: order.id,
    orderNo: order.orderNo,
    planId: order.planId,
    name: order.name,
    amountMinor: order.amountMinor,
    currency: order.currency,
    credits: order.credits,
    durationDays: order.durationDays,
    channel: order.channel,
    status: expired ? 'expired' : order.status,
    checkout:
      expired || order.status === 'paid' || !order.checkout
        ? null
        : safeCheckout(order.checkout as Checkout, order.channel),
    expiresAt: order.expiresAt.toISOString(),
    paidAt: order.paidAt?.toISOString() ?? null,
    fulfilledAt: order.fulfilledAt?.toISOString() ?? null,
    createdAt: order.createdAt.toISOString(),
  };
}
@Injectable()
export class BillingService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(WalletService) private readonly wallet: WalletService,
    @Inject(BILLING_RUNTIME) private readonly runtime: BillingRuntime,
  ) {}
  catalog() {
    return {
      enabled: this.runtime.enabled,
      plans: this.runtime.plans,
      channels: (['wechat', 'alipay'] as const).map((channel) => ({
        channel,
        enabled: this.runtime.enabled && this.runtime.adapters.some((a) => a.channel === channel),
      })),
    };
  }
  private adapter(channel: string, merchantId?: string, appId?: string) {
    const adapter = this.runtime.adapters.find(
      (a) =>
        a.channel === channel &&
        (!merchantId || a.merchantId === merchantId) &&
        (!appId || a.appId === appId),
    );
    if (!adapter)
      throw new AppError(503, 'PAYMENT_CHANNEL_UNAVAILABLE', 'Payment channel is unavailable');
    return adapter;
  }
  async create(userId: string, raw: unknown, key: string) {
    if (!this.runtime.enabled) throw new AppError(503, 'PAYMENTS_DISABLED', '支付暂未开通');
    const parsed = inputSchema.safeParse(raw);
    if (!parsed.success || !/^[a-zA-Z0-9_-]{16,100}$/.test(key ?? ''))
      throw new AppError(400, 'INVALID_INPUT', 'Order input or idempotency key is invalid');
    const input = parsed.data;
    const requestHash = hash(input);
    const result = await this.db.transaction(async (tx) => {
      await lockWallet(tx, userId);
      const previous = await tx.paymentOrder.findUnique({
        where: { userId_idempotencyKey: { userId, idempotencyKey: key } },
      });
      if (previous) {
        if (previous.requestHash !== requestHash)
          throw new AppError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'Idempotency key was used with different input',
          );
        return { order: previous, created: false };
      }
      const plan = this.runtime.plans.find((p) => p.id === input.planId);
      if (!plan) throw new AppError(404, 'PLAN_UNAVAILABLE', 'Credit pack is unavailable');
      const adapter = this.adapter(input.channel);
      const active = await tx.paymentOrder.count({
        where: { userId, status: { not: 'paid' }, expiresAt: { gt: new Date() } },
      });
      if (active >= 5) throw new AppError(429, 'TOO_MANY_ORDERS', '请先完成或等待已有订单到期');
      const order = await tx.paymentOrder.create({
        data: {
          userId,
          idempotencyKey: key,
          requestHash,
          orderNo: randomUUID().replaceAll('-', ''),
          planId: plan.id,
          name: plan.name,
          amountMinor: plan.amountMinor,
          credits: plan.credits,
          durationDays: plan.durationDays,
          channel: input.channel,
          merchantId: adapter.merchantId,
          appId: adapter.appId,
          expiresAt: new Date(Date.now() + 15 * 60_000),
        },
      });
      return { order, created: true };
    });
    if (result.created) {
      const order = result.order;
      try {
        const checkout = safeCheckout(
          await this.adapter(order.channel, order.merchantId, order.appId).create({
            orderNo: order.orderNo,
            amountMinor: order.amountMinor,
            description: order.name,
            expiresAt: order.expiresAt,
          }),
          order.channel,
        );
        await this.db.client.paymentOrder.updateMany({
          where: { id: order.id, status: 'creating' },
          data: { status: 'pending', checkout: { ...checkout }, lastError: null },
        });
      } catch {
        // Failure/timeout can mean accepted remotely. Never generate a new order number or silently retry create.
        await this.db.client.paymentOrder.updateMany({
          where: { id: order.id, status: 'creating' },
          data: { lastError: 'CREATE_UNCERTAIN' },
        });
      }
    }
    return this.get(userId, result.order.id);
  }
  async get(userId: string, id: string) {
    if (!z.string().uuid().safeParse(id).success)
      throw new AppError(404, 'NOT_FOUND', 'Order not found');
    const order = await this.db.client.paymentOrder.findFirst({ where: { id, userId } });
    if (!order) throw new AppError(404, 'NOT_FOUND', 'Order not found');
    return dto(order);
  }
  async confirm(fact: PaidFact): Promise<void> {
    if (
      !fact ||
      !['wechat', 'alipay'].includes(fact.channel) ||
      !Number.isSafeInteger(fact.amountMinor) ||
      fact.amountMinor <= 0 ||
      fact.currency !== 'CNY' ||
      !(fact.paidAt instanceof Date) ||
      !Number.isFinite(fact.paidAt.getTime()) ||
      fact.paidAt.getTime() > Date.now() + 300_000 ||
      [fact.orderNo, fact.tradeNo, fact.eventId, fact.merchantId, fact.appId].some(
        (v) => typeof v !== 'string' || !v || v.length > 200,
      )
    )
      throw new AppError(400, 'INVALID_PAYMENT', 'Payment fact is invalid');
    const found = await this.db.client.paymentOrder.findUnique({
      where: { orderNo: fact.orderNo },
    });
    if (!found) throw new AppError(404, 'NOT_FOUND', 'Order not found');
    const digest = hash([
      fact.channel,
      fact.merchantId,
      fact.appId,
      fact.orderNo,
      fact.tradeNo,
      fact.amountMinor,
      fact.currency,
    ]);
    await this.db.transaction(async (tx) => {
      await lockWallet(tx, found.userId);
      const order = await tx.paymentOrder.findUniqueOrThrow({ where: { id: found.id } });
      if (
        order.channel !== fact.channel ||
        order.merchantId !== fact.merchantId ||
        order.appId !== fact.appId ||
        order.amountMinor !== fact.amountMinor ||
        order.currency !== fact.currency ||
        (order.tradeNo && order.tradeNo !== fact.tradeNo)
      )
        throw new AppError(409, 'PAYMENT_CONFLICT', 'Payment does not match order');
      const unique = { channel: fact.channel, merchantId: fact.merchantId, eventId: fact.eventId };
      const event = await tx.paymentEvent.findUnique({
        where: { channel_merchantId_eventId: unique },
      });
      if (event && (event.digest !== digest || event.orderId !== order.id))
        throw new AppError(409, 'PAYMENT_CONFLICT', 'Payment event conflicts');
      if (!event) await tx.paymentEvent.create({ data: { ...unique, digest, orderId: order.id } });
      if (order.status === 'paid') return;
      const fulfilledAt = new Date();
      await this.wallet.grant(
        tx,
        order.userId,
        `payment:${order.id}`,
        BigInt(order.credits),
        new Date(fulfilledAt.getTime() + order.durationDays * 86400_000),
        { orderId: order.id, revenueMinor: BigInt(order.amountMinor) },
      );
      await tx.paymentOrder.update({
        where: { id: order.id },
        data: {
          status: 'paid',
          tradeNo: fact.tradeNo,
          paidAt: fact.paidAt,
          fulfilledAt,
          lastError: null,
          syncLeaseUntil: null,
        },
      });
    });
  }
  async notify(
    channel: string,
    raw: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ) {
    // Keep authenticated notifications available when new sales are paused, if keys remain configured.
    const fact = this.adapter(channel).verifyNotification(raw, headers);
    if (fact) await this.confirm(fact);
  }
  async sync(userId: string, id: string) {
    await this.get(userId, id);
    await this.syncOrder(id);
    return this.get(userId, id);
  }
  private async syncOrder(id: string) {
    const now = new Date();
    const claimed = await this.db.client.paymentOrder.updateMany({
      where: {
        id,
        status: { not: 'paid' },
        nextSyncAt: { lte: now },
        OR: [{ syncLeaseUntil: null }, { syncLeaseUntil: { lte: now } }],
      },
      data: {
        syncLeaseUntil: new Date(now.getTime() + 30_000),
        nextSyncAt: new Date(now.getTime() + 30_000),
      },
    });
    if (!claimed.count) return;
    const order = await this.db.client.paymentOrder.findUniqueOrThrow({ where: { id } });
    try {
      const paid = await this.adapter(order.channel, order.merchantId, order.appId).query(
        order.orderNo,
      );
      if (
        paid &&
        (paid.orderNo !== order.orderNo ||
          paid.channel !== order.channel ||
          paid.merchantId !== order.merchantId ||
          paid.appId !== order.appId)
      )
        throw new AppError(502, 'PAYMENT_CONFLICT', 'Query result does not match requested order');
      if (paid) await this.confirm(paid);
      await this.db.client.paymentOrder.updateMany({
        where: { id, status: { not: 'paid' } },
        data: { lastError: null },
      });
    } catch {
      await this.db.client.paymentOrder.updateMany({
        where: { id, status: { not: 'paid' } },
        data: { lastError: 'QUERY_UNCERTAIN' },
      });
    } finally {
      // Lease is allowed to expire, preventing an old worker clearing a newer worker's lease.
    }
  }
  async reconcile(): Promise<number> {
    const orders = await this.db.client.paymentOrder.findMany({
      where: { status: { not: 'paid' }, nextSyncAt: { lte: new Date() } },
      orderBy: { nextSyncAt: 'asc' },
      take: 100,
    });
    for (const order of orders) await this.syncOrder(order.id);
    return orders.length;
  }
}
