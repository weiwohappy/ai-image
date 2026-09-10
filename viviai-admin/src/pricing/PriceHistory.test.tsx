import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { AdminClient } from '../http';
import { json } from '../test/fixtures';
import { PriceHistory } from './PriceHistory';
import { priceRow } from './test-fixtures';
it('paginates scoped history and resets the cursor on refresh', async () => {
  const event = {
    id: 'event-1',
    createdAt: '2026-09-10T00:00:00Z',
    actor: '离线维护',
    modelId: 'gpt-image-2',
    resolution: '1K',
    action: 'model-pricing.import',
    before: null,
    after: { unitCredits: 100, enabled: true, version: 1 },
  };
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      json({ items: [event], nextCursor: 'next/token', asOf: event.createdAt }),
    )
    .mockResolvedValueOnce(
      json({
        items: [{ ...event, id: 'event-2', actor: '另一个管理员' }],
        nextCursor: null,
        asOf: event.createdAt,
      }),
    )
    .mockResolvedValue(json({ items: [], nextCursor: null, asOf: event.createdAt }));
  vi.stubGlobal('fetch', fetcher);
  render(<PriceHistory row={priceRow()} client={new AdminClient()} onClose={vi.fn()} />);
  expect(await screen.findByText('离线维护')).toBeInTheDocument();
  expect(screen.getByText(/离线导入/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  expect(await screen.findByText('另一个管理员')).toBeInTheDocument();
  expect(fetcher.mock.calls[1][0]).toBe(
    '/api/admin/model-pricing/gpt-image-2/history?resolution=1K&limit=30&cursor=next%2Ftoken',
  );
  expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '刷新历史' }));
  await screen.findByText('暂无价格变更记录');
  expect(fetcher.mock.calls[2][0]).not.toContain('cursor=');
});
it('distinguishes history fetch failure from an empty history', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(null, 503)));
  render(<PriceHistory row={priceRow()} client={new AdminClient()} onClose={vi.fn()} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('服务暂时不可用');
  expect(screen.queryByText('暂无价格变更记录')).not.toBeInTheDocument();
});
