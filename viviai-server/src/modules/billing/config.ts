import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { AlipayPaymentAdapter } from './alipay.js';
import { WechatPaymentAdapter } from './wechat.js';
import type { BillingPlan, BillingRuntime } from './billing.service.js';
const planSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{3,80}$/),
    name: z.string().min(1).max(60),
    amountMinor: z.number().int().min(1).max(10_000_000),
    credits: z.number().int().min(1).max(100_000_000),
    durationDays: z.number().int().min(1).max(366),
  })
  .strict();
export function parseBillingPlans(raw: unknown): BillingPlan[] {
  const plans = z.array(planSchema).max(30).parse(raw);
  if (new Set(plans.map((p) => p.id)).size !== plans.length)
    throw new Error('Duplicate billing plan version');
  return plans;
}
export function loadBillingRuntime(
  env: Record<string, string | undefined> = process.env,
): BillingRuntime {
  const flag = (name: string) => {
    if (env[name] === undefined || env[name] === 'false') return false;
    if (env[name] === 'true') return true;
    throw new Error(`${name} must be true or false`);
  };
  const required = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const secretFile = (name: string) => {
    try {
      const data = readFileSync(required(name));
      if (data.length > 65536) throw new Error();
      return data;
    } catch {
      throw new Error(`${name} must reference a readable key file`);
    }
  };
  const enabled = flag('BILLING_ENABLED');
  const plans = env.BILLING_CATALOG_FILE
    ? parseBillingPlans(JSON.parse(readFileSync(env.BILLING_CATALOG_FILE, 'utf8')))
    : [];
  const runtime: BillingRuntime = { enabled, plans, adapters: [] };
  if (flag('WECHAT_PAY_ENABLED')) {
    runtime.adapters.push(
      new WechatPaymentAdapter({
        merchantId: required('WECHAT_PAY_MCH_ID'),
        appId: required('WECHAT_PAY_APP_ID'),
        merchantSerial: required('WECHAT_PAY_SERIAL'),
        merchantPrivateKey: secretFile('WECHAT_PAY_PRIVATE_KEY_FILE'),
        apiV3Key: required('WECHAT_PAY_API_V3_KEY'),
        platformPublicKeys: {
          [required('WECHAT_PAY_PUBLIC_KEY_ID')]: secretFile('WECHAT_PAY_PUBLIC_KEY_FILE'),
        },
        notifyUrl: required('WECHAT_PAY_NOTIFY_URL'),
      }),
    );
  }
  if (flag('ALIPAY_ENABLED')) {
    runtime.adapters.push(
      new AlipayPaymentAdapter({
        appId: required('ALIPAY_APP_ID'),
        sellerId: required('ALIPAY_SELLER_ID'),
        privateKey: secretFile('ALIPAY_PRIVATE_KEY_FILE'),
        alipayPublicKey: secretFile('ALIPAY_PUBLIC_KEY_FILE'),
        notifyUrl: required('ALIPAY_NOTIFY_URL'),
        returnUrl: required('ALIPAY_RETURN_URL'),
      }),
    );
  }
  if (enabled && (!plans.length || !runtime.adapters.length))
    throw new Error(
      'Billing activation requires an approved catalog and at least one configured merchant',
    );
  return runtime;
}
