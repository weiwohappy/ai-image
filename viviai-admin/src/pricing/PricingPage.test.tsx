import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { AdminClient } from '../http';
import { json } from '../test/fixtures';
import { PricingPage } from './PricingPage';
import { priceRow, pricingActor, setupPricingApi } from './test-fixtures';
import { safeRoute } from '../format';
import { availableNavigation, routePermission } from '../navigation';

function page(props = {}) {
  return render(
    <PricingPage
      client={new AdminClient()}
      actor={pricingActor}
      writeEnabled
      onPermissionsChanged={vi.fn()}
      {...props}
    />,
  );
}
it('shows unpriced supported tuples separately from API readiness, with a safe menu route', async () => {
  setupPricingApi();
  page();
  expect(await screen.findByText('未配置')).toBeInTheDocument();
  expect(screen.getByText('API 未就绪')).toBeInTheDocument();
  expect(screen.getByText('1:1 · 1024 × 1024')).toBeInTheDocument();
  expect(screen.queryByText('16:9')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '配置 gpt-image-2 1K' })).toBeEnabled();
  expect(availableNavigation(pricingActor).some((n) => n.path === '/model-pricing')).toBe(true);
  expect(routePermission('/model-pricing?modelId=gpt-image-2')).toBe('models.read');
  expect(safeRoute('/model-pricing?modelId=gpt-image-2')).toBe(
    '/model-pricing?modelId=gpt-image-2',
  );
  expect(safeRoute('/model-pricing?modelId=../../users')).toBeNull();
  expect(safeRoute('/model-pricing?redirect=https://evil.test')).toBeNull();
});
it.each(['permission', 'status', 'server', 'action'])(
  'does not offer mutations without the %s gate',
  async (gate) => {
    setupPricingApi({
      writeEnabled: gate !== 'server',
      row: priceRow(gate === 'action' ? { allowedActions: [] } : {}),
    });
    page({
      writeEnabled: gate !== 'status',
      actor:
        gate === 'permission' ? { ...pricingActor, permissions: ['models.read'] } : pricingActor,
    });
    await screen.findByText('未配置');
    expect(screen.queryByRole('button', { name: '配置 gpt-image-2 1K' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '历史 gpt-image-2 1K' })).toBeEnabled();
  },
);
it('uses an exact model filter and opens scoped read-only history', async () => {
  const { requests } = setupPricingApi();
  page({ initialModelId: 'gpt-image-2' });
  await screen.findByText('未配置');
  expect(requests).toContain('/api/admin/model-pricing?modelId=gpt-image-2');
  fireEvent.click(screen.getByRole('button', { name: '历史 gpt-image-2 1K' }));
  expect(await screen.findByText('暂无价格变更记录')).toBeInTheDocument();
  expect(requests).toContain('/api/admin/model-pricing/gpt-image-2/history?resolution=1K&limit=30');
});
it('refreshes saved prices and history without reporting success before persistence', async () => {
  const { commands } = setupPricingApi();
  page();
  fireEvent.click(await screen.findByRole('button', { name: '配置 gpt-image-2 1K' }));
  fireEvent.change(screen.getByLabelText('单张积分'), { target: { value: '120' } });
  fireEvent.change(screen.getByLabelText('操作原因'), { target: { value: '测试积分定价' } });
  fireEvent.click(screen.getByRole('button', { name: '保存价格' }));
  expect(await screen.findByText('积分价格已保存')).toBeInTheDocument();
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({
    method: 'PUT',
    path: '/model-pricing/gpt-image-2/1K',
    body: { unitCredits: 120, enabled: true, expectedVersion: 0, reason: '测试积分定价' },
  });
  expect(commands[0].key).toMatch(/^[0-9a-f-]{36}$/);
  fireEvent.click(screen.getByRole('button', { name: '完成' }));
  expect(await screen.findByText('120 积分')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '历史 gpt-image-2 1K' }));
  expect(await screen.findByText('测试管理员')).toBeInTheDocument();
  expect(
    within(screen.getByRole('dialog')).getByText(/120 积分 · 已启用 · v1/),
  ).toBeInTheDocument();
});
it('shows a retryable read failure without fallback prices', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(json(null, 503))
    .mockResolvedValue(
      json({ items: [priceRow()], writeEnabled: true, asOf: '2026-09-10T00:00:00Z' }),
    );
  vi.stubGlobal('fetch', fetcher);
  page();
  expect(await screen.findByRole('alert')).toHaveTextContent('服务暂时不可用');
  expect(screen.queryByRole('button', { name: /配置 gpt/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  expect(await screen.findByText('未配置')).toBeInTheDocument();
});
it('removes an open editor when the write permission is revoked', async () => {
  setupPricingApi();
  const client = new AdminClient();
  const view = page({ client });
  fireEvent.click(await screen.findByRole('button', { name: '配置 gpt-image-2 1K' }));
  expect(screen.getByLabelText('单张积分')).toBeInTheDocument();
  view.rerender(
    <PricingPage
      client={client}
      actor={{ ...pricingActor, permissions: ['models.read'] }}
      writeEnabled
      onPermissionsChanged={vi.fn()}
    />,
  );
  await waitFor(() => expect(screen.queryByLabelText('单张积分')).not.toBeInTheDocument());
});
