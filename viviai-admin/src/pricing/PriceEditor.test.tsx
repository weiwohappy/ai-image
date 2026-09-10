import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { AdminClient } from '../http';
import { PriceEditor } from './PriceEditor';
import { priceRow, setupPricingApi } from './test-fixtures';
function editor(
  options: Parameters<typeof setupPricingApi>[0] = {},
  action: 'create' | 'edit' | 'disable' | 'enable' = 'create',
) {
  const api = setupPricingApi(options);
  const client = new AdminClient();
  const props = {
    client,
    row: options.row ?? priceRow(),
    action,
    onClose: vi.fn(),
    onChanged: vi.fn(),
    onPermissionsChanged: vi.fn().mockResolvedValue(undefined),
  };
  client.onUnauthorized = vi.fn();
  render(<PriceEditor {...props} />);
  return { ...api, ...props };
}
function fill(value = '120') {
  fireEvent.change(screen.getByLabelText('单张积分'), { target: { value } });
  fireEvent.change(screen.getByLabelText('操作原因'), { target: { value: '测试积分定价' } });
}
it.each(['', '0', '-1', '1.5', '1000001', 'NaN', 'Infinity', '1e2'])(
  'rejects invalid credit input %s without issuing a command',
  async (value) => {
    const f = editor();
    // Allow the popup's initial-focus lifecycle before simulating user submission.
    await waitFor(() =>
      expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement),
    );
    fill(value);
    fireEvent.click(screen.getByRole('button', { name: '保存价格' }));
    expect(await screen.findByText('单张积分需为 1–1,000,000 的整数')).toBeInTheDocument();
    expect(screen.getByLabelText('单张积分')).toHaveFocus();
    expect(f.commands).toHaveLength(0);
  },
);
it('previews total from resolution price and count without permitting size edits', () => {
  editor();
  fill('120');
  fireEvent.change(screen.getByLabelText('示例张数'), { target: { value: '4' } });
  expect(screen.getByText('480 积分')).toBeInTheDocument();
  expect(screen.getByText(/已提交任务不变/)).toBeInTheDocument();
  expect(screen.queryByRole('combobox', { name: '分辨率' })).not.toBeInTheDocument();
  expect(screen.getByLabelText('价格启用')).toBeChecked();
});
it('keeps a stale draft, reloads current baseline and submits the refreshed version', async () => {
  const f = editor({ failOnce: 409 });
  fill();
  fireEvent.click(screen.getByRole('button', { name: '保存价格' }));
  fireEvent.click(await screen.findByRole('button', { name: '加载最新记录' }));
  await waitFor(() => expect(screen.getByLabelText('单张积分')).toBeEnabled());
  expect(screen.getByLabelText('单张积分')).toHaveValue('120');
  expect(screen.getByText(/最新记录：180 积分.*v2/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '保存价格' }));
  await waitFor(() => expect(f.onChanged).toHaveBeenCalledOnce());
  expect(f.commands[1].body.expectedVersion).toBe(2);
  expect(f.commands[1].key).not.toBe(f.commands[0].key);
});
it('freezes an uncertain result and retries the identical body and idempotency key', async () => {
  const f = editor({ loseOnce: true });
  fill();
  fireEvent.click(screen.getByRole('button', { name: '保存价格' }));
  const retry = await screen.findByRole('button', { name: '重试同一操作' });
  expect(screen.getByLabelText('单张积分')).toBeDisabled();
  expect(f.onChanged).not.toHaveBeenCalled();
  fireEvent.click(retry);
  await waitFor(() => expect(f.onChanged).toHaveBeenCalledOnce());
  expect(f.commands[1]).toEqual(f.commands[0]);
});
it('refreshes forbidden permissions and never signals a successful save', async () => {
  const f = editor({ failOnce: 403 });
  fill();
  fireEvent.click(screen.getByRole('button', { name: '保存价格' }));
  await waitFor(() => expect(f.onPermissionsChanged).toHaveBeenCalledOnce());
  expect(f.onChanged).not.toHaveBeenCalled();
});
it('invalidates an expired session', async () => {
  const f = editor({ failOnce: 401 });
  fill();
  fireEvent.click(screen.getByRole('button', { name: '保存价格' }));
  await waitFor(() => expect(f.client.onUnauthorized).toHaveBeenCalledOnce());
  expect(f.onChanged).not.toHaveBeenCalled();
});
it.each([
  ['disable', false, '确认停用'],
  ['enable', true, '确认启用'],
] as const)(
  'submits %s as an explicit full state with the original price',
  async (action, enabled, label) => {
    const f = editor(
      { row: priceRow({ priceId: 'price-1', unitCredits: 100, enabled: !enabled, version: 3 }) },
      action,
    );
    fireEvent.change(screen.getByLabelText('操作原因'), { target: { value: '测试价格状态变更' } });
    fireEvent.click(screen.getByRole('button', { name: label }));
    await waitFor(() => expect(f.onChanged).toHaveBeenCalledOnce());
    expect(f.commands[0].body).toEqual({
      unitCredits: 100,
      enabled,
      expectedVersion: 3,
      reason: '测试价格状态变更',
    });
  },
);
it('requires explicit draft discard and aborts pending transport when unmounted', async () => {
  const api = setupPricingApi();
  const client = new AdminClient(),
    onClose = vi.fn();
  const view = render(
    <PriceEditor
      client={client}
      row={priceRow()}
      action="create"
      onClose={onClose}
      onChanged={vi.fn()}
      onPermissionsChanged={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
  api.fetcher.mockImplementation(() => new Promise(() => {}));
  fill();
  fireEvent.click(screen.getByRole('button', { name: '保存价格' }));
  expect(screen.getByLabelText('单张积分')).toBeDisabled();
  const signal = api.fetcher.mock.calls[0][1]?.signal;
  view.unmount();
  expect(signal?.aborted).toBe(true);
});
it('does not roll back a newly changed price when retrying a state-only action', async () => {
  const f = editor(
    {
      row: priceRow({ priceId: 'price-1', unitCredits: 100, enabled: true, version: 1 }),
      failOnce: 409,
    },
    'disable',
  );
  fireEvent.change(screen.getByLabelText('操作原因'), { target: { value: '测试价格状态变更' } });
  fireEvent.click(screen.getByRole('button', { name: '确认停用' }));
  fireEvent.click(await screen.findByRole('button', { name: '加载最新记录' }));
  await waitFor(() => expect(screen.getByLabelText('单张积分')).toBeEnabled());
  expect(screen.getByLabelText('单张积分')).toHaveValue('180');
  fireEvent.click(screen.getByRole('button', { name: '确认停用' }));
  await waitFor(() => expect(f.onChanged).toHaveBeenCalledOnce());
  expect(f.commands[1].body).toMatchObject({
    unitCredits: 180,
    enabled: false,
    expectedVersion: 2,
  });
});
