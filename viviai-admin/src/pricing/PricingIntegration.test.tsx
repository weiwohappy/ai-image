import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import AdminApp from '../AdminApp';
import { DetailPage } from '../DetailPage';
import { AdminClient } from '../http';
import { json } from '../test/fixtures';
import { priceRow, pricingActor } from './test-fixtures';

it('opens the filtered pricing route using server status and refreshes permissions after a denied save', async () => {
  window.history.replaceState(null, '', '#/model-pricing?modelId=gpt-image-2');
  let write = true,
    reads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/status'))
        return json({
          enabled: true,
          environment: 'development',
          stage: 'B1',
          teamWritesEnabled: true,
          modelPricingWritesEnabled: true,
        });
      if (url.endsWith('/me')) return json(pricingActor);
      if (init?.method === 'PUT') {
        write = false;
        return json(null, 403);
      }
      if (url === '/api/admin/model-pricing?modelId=gpt-image-2') {
        reads++;
        return json({ items: [priceRow()], asOf: '2026-09-10T00:00:00Z', writeEnabled: write });
      }
      return json(null, 404);
    }),
  );
  render(<AdminApp />);
  fireEvent.click(await screen.findByRole('button', { name: '配置 gpt-image-2 1K' }));
  expect(screen.getByRole('link', { name: '积分定价', hidden: true })).toHaveAttribute(
    'href',
    '#/model-pricing',
  );
  fireEvent.change(screen.getByLabelText('单张积分'), { target: { value: '120' } });
  fireEvent.change(screen.getByLabelText('操作原因'), { target: { value: '测试权限刷新' } });
  fireEvent.click(screen.getByRole('button', { name: '保存价格' }));
  await waitFor(() => expect(reads).toBe(2));
  expect(screen.queryByLabelText('单张积分')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '配置 gpt-image-2 1K' })).not.toBeInTheDocument();
});
it('links model detail to its exact pricing filter', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        json({ id: 'gpt-image-2', title: 'GPT Image 2', fields: [], tables: [], notices: [] }),
      ),
  );
  render(
    <DetailPage
      path="/models/gpt-image-2"
      client={new AdminClient()}
      permissions={['models.read']}
    />,
  );
  expect(await screen.findByRole('link', { name: '查看积分定价' })).toHaveAttribute(
    'href',
    '#/model-pricing?modelId=gpt-image-2',
  );
});
