import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { AdminClient } from '../http';
import { json } from '../test/fixtures';
import { ConsoleShell } from '../ConsoleShell';
import { PricingPage } from './PricingPage';
import { PriceEditor } from './PriceEditor';
import { priceRow, pricingActor, setupPricingApi } from './test-fixtures';

it('closes a writable draft while pricing authority is being refreshed and stays closed on error', async () => {
  const api = setupPricingApi();
  render(
    <PricingPage
      actor={pricingActor}
      client={new AdminClient()}
      writeEnabled
      onPermissionsChanged={vi.fn()}
    />,
  );
  fireEvent.click(await screen.findByRole('button', { name: '配置 gpt-image-2 1K' }));
  api.fetcher.mockImplementation(async () => json(null, 503));
  // Simulate an external refresh while the modal is open, not a successful save.
  fireEvent.click(screen.getByRole('button', { name: '刷新', hidden: true }));
  expect(screen.queryByLabelText('单张积分')).not.toBeInTheDocument();
  expect(await screen.findByRole('alert')).toHaveTextContent('服务暂时不可用');
  expect(api.commands).toHaveLength(0);
});
it('does not let an edit-only action change enabled state and warns against customer content', () => {
  const row = priceRow({
    priceId: 'price-1',
    unitCredits: 100,
    enabled: true,
    version: 1,
    allowedActions: [{ action: 'edit', allowed: true, reasonCode: null }],
  });
  setupPricingApi({ row });
  render(
    <PriceEditor
      row={row}
      action="edit"
      client={new AdminClient()}
      onClose={vi.fn()}
      onChanged={vi.fn()}
      onPermissionsChanged={vi.fn()}
    />,
  );
  expect(screen.getByLabelText('价格启用')).toBeDisabled();
  expect(screen.getByText(/不要填写密码、密钥或客户内容/)).toBeInTheDocument();
});
it('blocks a state-only conflict retry when fresh allowedActions no longer permit it', async () => {
  const row = priceRow({ priceId: 'price-1', unitCredits: 100, enabled: true, version: 1 });
  const api = setupPricingApi({ row });
  let puts = 0;
  api.fetcher.mockImplementation(async (_path, init) => {
    if (init?.method === 'PUT') {
      puts++;
      return json(null, 409);
    }
    return json({
      ...row,
      enabled: false,
      version: 2,
      allowedActions: [{ action: 'disable', allowed: false, reasonCode: 'PRICE_VERSION_CONFLICT' }],
    });
  });
  render(
    <PriceEditor
      row={row}
      action="disable"
      client={new AdminClient()}
      onClose={vi.fn()}
      onChanged={vi.fn()}
      onPermissionsChanged={vi.fn()}
    />,
  );
  fireEvent.change(screen.getByLabelText('操作原因'), { target: { value: '测试价格状态变更' } });
  fireEvent.click(screen.getByRole('button', { name: '确认停用' }));
  fireEvent.click(await screen.findByRole('button', { name: '加载最新记录' }));
  await waitFor(() => expect(screen.getByLabelText('操作原因')).toBeEnabled());
  expect(screen.getByRole('button', { name: '确认停用' })).toBeDisabled();
  expect(screen.getByText(/当前记录已不允许此操作/)).toBeInTheDocument();
  expect(puts).toBe(1);
});
it.each([
  [false, true, '积分定价管理', '积分定价可管理；团队及其他业务模块写操作未开放'],
  [true, false, '团队管理 B1', '团队管理已开放，业务模块仍为只读'],
  [true, true, '团队与定价管理', '团队与积分定价可管理，其他业务模块仍为只读'],
] as const)(
  'describes independent team %s and pricing %s flags accurately',
  async (team, pricing, heading, footer) => {
    window.history.replaceState(null, '', '#/model-pricing');
    setupPricingApi();
    render(
      <ConsoleShell
        actor={pricingActor}
        client={new AdminClient()}
        environment="development"
        stage="B1"
        teamWritesEnabled={team}
        modelPricingWritesEnabled={pricing}
        onLogout={vi.fn()}
        onPermissionsChanged={vi.fn()}
      />,
    );
    expect(await screen.findByText(`development · ${heading}`)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(footer))).toBeInTheDocument();
  },
);
