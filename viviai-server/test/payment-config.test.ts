import { describe, expect, it } from 'vitest';
import { loadBillingRuntime, parseBillingPlans } from '../src/modules/billing/config.js';
describe('payment activation controls', () => {
  it('defaults to no sales, no credentials, no catalog', () => {
    expect(loadBillingRuntime({})).toEqual({ enabled: false, plans: [], adapters: [] });
  });
  it('cannot activate with missing merchant config or implicit boolean truthiness', () => {
    for (const env of [
      { BILLING_ENABLED: 'true' },
      { BILLING_ENABLED: '1' },
      { WECHAT_PAY_ENABLED: 'true' },
      { ALIPAY_ENABLED: 'true' },
    ])
      expect(() => loadBillingRuntime(env)).toThrow();
  });
  it('rejects fractional/negative prices, duplicated version IDs and unimplemented promises', () => {
    const good = {
      id: 'credits-1-v1',
      name: '积分包',
      amountMinor: 2900,
      credits: 1000,
      durationDays: 30,
    };
    expect(parseBillingPlans([good])).toEqual([good]);
    for (const bad of [
      [{ ...good, amountMinor: 0.01 }],
      [{ ...good, credits: -1 }],
      [good, good],
      [{ ...good, concurrency: 4 }],
      [{ ...good, durationDays: 0 }],
    ])
      expect(() => parseBillingPlans(bad)).toThrow();
  });
});
