import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { http, HttpResponse } from 'msw';
import { server } from '@/src/mocks/server';
import { PricingPage } from './PricingPage';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
const plan = {
  id: 'credits-v1',
  name: '创作积分包',
  amountMinor: 2900,
  credits: 1000,
  durationDays: 30,
};
const envelope = (data: unknown) =>
  HttpResponse.json({ data, message: 'ok', requestId: 'test' });
const catalog = {
  enabled: true,
  plans: [plan],
  channels: [
    { channel: 'wechat', enabled: true },
    { channel: 'alipay', enabled: true },
  ],
};
const pending = {
  id: 'order-1',
  orderNo: 'merchant-order-1',
  planId: plan.id,
  name: plan.name,
  amountMinor: 2900,
  currency: 'CNY',
  credits: 1000,
  durationDays: 30,
  channel: 'wechat',
  status: 'pending',
  checkout: { kind: 'qr', url: 'weixin://wxpay/bizpayurl?pr=test' },
  expiresAt: new Date(Date.now() + 900000).toISOString(),
  paidAt: null,
  fulfilledAt: null,
};
beforeEach(() => {
  localStorage.clear();
  server.use(
    http.get('*/api/billing/catalog', () => envelope(catalog)),
    http.get('*/api/billing/me', () =>
      envelope({ id: 'real-user', email: 'real@example.test', credits: 0 }),
    ),
    http.get('*/api/billing/orders/:id', () => envelope(pending)),
  );
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <PricingPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
describe('official payment checkout', () => {
  it('shows unavailable channels and cannot simulate credit purchases before activation', async () => {
    server.use(
      http.get('*/api/billing/catalog', () =>
        envelope({ ...catalog, enabled: false, plans: [] }),
      ),
    );
    mount();
    expect(await screen.findByText('支付暂未开通')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: '模拟支付成功' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /购买/ }),
    ).not.toBeInTheDocument();
  });
  it('only verified paid order state shows credits received, never clicking I paid', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('*/api/billing/orders', () => envelope(pending)),
      http.post('*/api/billing/orders/:id/sync', () =>
        envelope({
          ...pending,
          status: 'paid',
          checkout: null,
          fulfilledAt: new Date().toISOString(),
        }),
      ),
    );
    mount();
    await user.click(
      await screen.findByRole('button', { name: '购买创作积分包' }),
    );
    await user.click(screen.getByRole('radio', { name: '微信支付' }));
    await user.click(screen.getByRole('button', { name: '确认下单' }));
    expect(await screen.findByText('等待支付确认')).toBeVisible();
    expect(screen.getByLabelText('微信支付二维码')).toBeInTheDocument();
    expect(screen.queryByText('积分已到账')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '查询支付结果' }));
    expect(await screen.findByText('积分已到账')).toBeVisible();
  });
  it('retries an uncertain request with the same idempotency key', async () => {
    const keys: string[] = [];
    const user = userEvent.setup();
    server.use(
      http.post('*/api/billing/orders', ({ request }) => {
        keys.push(request.headers.get('Idempotency-Key')!);
        return keys.length === 1
          ? HttpResponse.json(
              { code: 'UNAVAILABLE', message: '暂时不可用' },
              { status: 503 },
            )
          : envelope(pending);
      }),
    );
    mount();
    await user.click(
      await screen.findByRole('button', { name: '购买创作积分包' }),
    );
    await user.click(screen.getByRole('radio', { name: '微信支付' }));
    await user.click(screen.getByRole('button', { name: '确认下单' }));
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: '重试原订单' }));
    await screen.findByText('等待支付确认');
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });
  it('does not offer purchases to a Mock-only account', async () => {
    server.use(
      http.get('*/api/billing/me', () =>
        HttpResponse.json(
          { code: 'AUTH_REQUIRED', message: '请登录' },
          { status: 401 },
        ),
      ),
    );
    mount();
    expect(await screen.findByText('登录真实账户')).toBeVisible();
    expect(
      screen.getByRole('button', { name: '购买创作积分包' }),
    ).toBeDisabled();
  });
  it('rejects untrusted redirect URLs instead of presenting a payment link', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('*/api/billing/orders', () =>
        envelope({
          ...pending,
          channel: 'alipay',
          checkout: {
            kind: 'redirect',
            url: 'https://evil.example/gateway.do',
          },
        }),
      ),
    );
    mount();
    await user.click(
      await screen.findByRole('button', { name: '购买创作积分包' }),
    );
    await user.click(screen.getByRole('radio', { name: '支付宝' }));
    await user.click(screen.getByRole('button', { name: '确认下单' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('支付链接无效');
    expect(
      screen.queryByRole('link', { name: '前往支付宝付款' }),
    ).not.toBeInTheDocument();
  });
  it('allows another purchase after a paid order and keeps the last order for lookup', async () => {
    const user = userEvent.setup();
    let count = 0;
    const paid = {
      ...pending,
      status: 'paid',
      checkout: null,
      fulfilledAt: new Date().toISOString(),
    };
    server.use(
      http.post('*/api/billing/orders', () => {
        count++;
        return envelope(paid);
      }),
      http.get('*/api/billing/orders/:id', () => envelope(paid)),
    );
    mount();
    await user.click(
      await screen.findByRole('button', { name: '购买创作积分包' }),
    );
    await user.click(screen.getByRole('radio', { name: '微信支付' }));
    await user.click(screen.getByRole('button', { name: '确认下单' }));
    await screen.findByText('积分已到账');
    await user.click(screen.getByRole('button', { name: '完成' }));
    await user.click(screen.getByRole('button', { name: '购买创作积分包' }));
    expect(
      await screen.findByRole('button', { name: '确认下单' }),
    ).toBeVisible();
    expect(count).toBe(1);
    expect(localStorage.getItem('viviai:payment-order:real-user')).toBe(
      'order-1',
    );
  });
  it('resumes an existing order without submitting again after closing the dialog', async () => {
    const user = userEvent.setup();
    let count = 0;
    server.use(
      http.post('*/api/billing/orders', () => {
        count++;
        return envelope(pending);
      }),
    );
    mount();
    await user.click(
      await screen.findByRole('button', { name: '购买创作积分包' }),
    );
    await user.click(screen.getByRole('radio', { name: '微信支付' }));
    await user.click(screen.getByRole('button', { name: '确认下单' }));
    await screen.findByText('等待支付确认');
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: '购买创作积分包' }));
    expect(await screen.findByText('等待支付确认')).toBeVisible();
    expect(count).toBe(1);
  });
  it('hides expired checkout and lets the user explicitly confirm nonpayment before starting over', async () => {
    const user = userEvent.setup();
    const expired = {
      ...pending,
      status: 'expired',
      expiresAt: new Date(Date.now() - 10000).toISOString(),
    };
    server.use(
      http.post('*/api/billing/orders', () => envelope(expired)),
      http.get('*/api/billing/orders/:id', () => envelope(expired)),
    );
    mount();
    await user.click(
      await screen.findByRole('button', { name: '购买创作积分包' }),
    );
    await user.click(screen.getByRole('radio', { name: '微信支付' }));
    await user.click(screen.getByRole('button', { name: '确认下单' }));
    await screen.findByText(/订单支付入口已过期/);
    expect(screen.queryByLabelText('微信支付二维码')).not.toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: '确认未付款，返回选择' }),
    );
    await user.click(screen.getByRole('button', { name: '购买创作积分包' }));
    expect(
      await screen.findByRole('button', { name: '确认下单' }),
    ).toBeVisible();
  });
});
