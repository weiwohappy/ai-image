import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';
import { WalletService } from '../../src/modules/wallet/wallet.service.js';
import { BillingService } from '../../src/modules/billing/billing.service.js';
import type {
  PaymentAdapter,
  PaidFact,
  PaymentRequest,
} from '../../src/modules/billing/contracts.js';

const plan = {
  id: 'test-v1',
  name: '测试积分包',
  amountMinor: 2900,
  credits: 1000,
  durationDays: 30,
};
describe('durable paid-credit fulfillment', () => {
  let db: TestDatabase;
  let wallet: WalletService;
  beforeAll(async () => {
    db = await createTestDatabase();
    wallet = new WalletService(db.database);
  });
  afterAll(async () => {
    await db?.cleanup();
  });
  async function actor() {
    const id = randomUUID();
    await db.database.client.user.create({
      data: { id, email: `${id}@example.test`, username: id, passwordHash: 'unused' },
    });
    return id;
  }
  function setup(options: { enabled?: boolean; failCreate?: boolean } = {}) {
    const submissions: PaymentRequest[] = [];
    let paid: PaidFact | null = null;
    const adapter: PaymentAdapter = {
      channel: 'wechat',
      merchantId: 'merchant-test',
      appId: 'wx-test',
      async create(input) {
        submissions.push(input);
        if (options.failCreate) throw new Error('network timeout');
        return { kind: 'qr', url: 'weixin://wxpay/bizpayurl?pr=test' };
      },
      async query(orderNo) {
        if (paid && paid.orderNo !== orderNo) throw new Error('wrong lookup');
        return paid;
      },
      verifyNotification() {
        throw new Error('not used by service-level tests');
      },
    };
    const service = new BillingService(db.database, wallet, {
      enabled: options.enabled ?? true,
      plans: [plan],
      adapters: [adapter],
    });
    const fact = (orderNo: string): PaidFact => ({
      channel: 'wechat',
      eventId: randomUUID(),
      orderNo,
      tradeNo: randomUUID(),
      merchantId: 'merchant-test',
      appId: 'wx-test',
      amountMinor: 2900,
      currency: 'CNY',
      paidAt: new Date(),
    });
    return {
      service,
      submissions,
      fact,
      setPaid(value: PaidFact) {
        paid = value;
      },
    };
  }
  it('disabled mode cannot create an order or call a provider', async () => {
    const user = await actor();
    const { service, submissions } = setup({ enabled: false });
    await expect(
      service.create(user, { planId: plan.id, channel: 'wechat' }, randomUUID()),
    ).rejects.toMatchObject({ code: 'PAYMENTS_DISABLED' });
    expect(await db.database.client.paymentOrder.count({ where: { userId: user } })).toBe(0);
    expect(submissions).toHaveLength(0);
  });
  it('concurrent same-key creates submit only once, server price wins, changed input conflicts', async () => {
    const user = await actor();
    const { service, submissions } = setup();
    const key = randomUUID();
    const orders = await Promise.all(
      Array.from({ length: 20 }, () =>
        service.create(user, { planId: plan.id, channel: 'wechat' }, key),
      ),
    );
    expect(new Set(orders.map((o) => o.id)).size).toBe(1);
    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.amountMinor).toBe(2900);
    await expect(
      service.create(user, { planId: plan.id, channel: 'alipay' }, key),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      service.create(user, { planId: plan.id, channel: 'wechat', amountMinor: 1 }, randomUUID()),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
  it('100 replays and distinct query events grant only one paid lot and one ledger entry', async () => {
    const user = await actor();
    const { service, fact } = setup();
    const order = await service.create(user, { planId: plan.id, channel: 'wechat' }, randomUUID());
    const payment = fact(order.orderNo);
    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        service.confirm({
          ...payment,
          eventId: i % 2 ? payment.eventId : `query:${payment.tradeNo}`,
        }),
      ),
    );
    expect((await service.get(user, order.id)).status).toBe('paid');
    expect(await wallet.balance(user)).toMatchObject({ available: 1000n, issued: 1000n });
    const lots = await db.database.client.creditLot.findMany({ where: { userId: user } });
    expect(lots).toHaveLength(1);
    expect(lots[0]?.revenueMinor).toBe(2900n);
    expect(
      await db.database.client.creditEvent.findMany({ where: { userId: user } }),
    ).toMatchObject([{ type: 'paid_grant', availableDelta: 1000n }]);
  }, 30_000);
  it('wrong amount, identity, currency and conflicting trade cannot fulfill', async () => {
    const user = await actor();
    const { service, fact } = setup();
    const order = await service.create(user, { planId: plan.id, channel: 'wechat' }, randomUUID());
    const payment = fact(order.orderNo);
    for (const patch of [
      { amountMinor: 1 },
      { merchantId: 'other' },
      { appId: 'other' },
      { currency: 'USD' },
      { paidAt: new Date(NaN) },
    ]) {
      await expect(service.confirm({ ...payment, ...patch } as PaidFact)).rejects.toBeDefined();
    }
    expect((await wallet.balance(user)).available).toBe(0n);
    await service.confirm(payment);
    await expect(
      service.confirm({ ...payment, tradeNo: randomUUID(), eventId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'PAYMENT_CONFLICT' });
    expect((await wallet.balance(user)).available).toBe(1000n);
  });
  it('owner isolation and upstream trade uniqueness prevent double credit across orders', async () => {
    const first = await actor();
    const second = await actor();
    const { service, fact } = setup();
    const a = await service.create(first, { planId: plan.id, channel: 'wechat' }, randomUUID());
    const b = await service.create(second, { planId: plan.id, channel: 'wechat' }, randomUUID());
    await expect(service.get(second, a.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(service.sync(second, a.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const payment = fact(a.orderNo);
    await service.confirm(payment);
    await expect(
      service.confirm({ ...payment, orderNo: b.orderNo, eventId: randomUUID() }),
    ).rejects.toBeDefined();
    expect((await wallet.balance(second)).available).toBe(0n);
    expect((await service.get(second, b.id)).status).not.toBe('paid');
  });
  it('expired checkout can still fulfill a verified late payment with fresh validity', async () => {
    const user = await actor();
    const { service, fact } = setup();
    const order = await service.create(user, { planId: plan.id, channel: 'wechat' }, randomUUID());
    await db.database.client.paymentOrder.update({
      where: { id: order.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await service.get(user, order.id)).status).toBe('expired');
    const start = Date.now();
    await service.confirm(fact(order.orderNo));
    const lot = await db.database.client.creditLot.findFirstOrThrow({ where: { userId: user } });
    expect(lot.expiresAt!.getTime()).toBeGreaterThanOrEqual(start + 30 * 86400_000);
    expect((await service.get(user, order.id)).status).toBe('paid');
  });
  it('ambiguous creation is never submitted twice and recovery queries the original order', async () => {
    const user = await actor();
    const { service, submissions, fact, setPaid } = setup({ failCreate: true });
    const key = randomUUID();
    const order = await service.create(user, { planId: plan.id, channel: 'wechat' }, key);
    expect(order.status).toBe('creating');
    expect(order.checkout).toBeNull();
    await service.create(user, { planId: plan.id, channel: 'wechat' }, key);
    expect(submissions).toHaveLength(1);
    setPaid(fact(order.orderNo));
    await service.reconcile();
    expect((await service.get(user, order.id)).status).toBe('paid');
    expect((await wallet.balance(user)).available).toBe(1000n);
  });
  it('event id reuse with another order rolls back the grant', async () => {
    const user = await actor();
    const { service, fact } = setup();
    const a = await service.create(user, { planId: plan.id, channel: 'wechat' }, randomUUID());
    const b = await service.create(user, { planId: plan.id, channel: 'wechat' }, randomUUID());
    const p = fact(a.orderNo);
    await service.confirm(p);
    await expect(service.confirm({ ...fact(b.orderNo), eventId: p.eventId })).rejects.toMatchObject(
      { code: 'PAYMENT_CONFLICT' },
    );
    expect((await wallet.balance(user)).available).toBe(1000n);
    expect((await service.get(user, b.id)).status).not.toBe('paid');
  });
});
