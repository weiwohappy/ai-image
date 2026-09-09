import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { it, expect, vi } from 'vitest';
import { ResourcePage } from './ResourcePage';
import { DashboardPage } from './DashboardPage';
import { ModelSpecs } from './ModelSpecs';
import { availableNavigation } from './navigation';
import { AdminClient } from './http';
import { actor, emptyTable, json } from './test/fixtures';

it('shows unavailable profit without inventing zero', () => {
  render(
    <DashboardPage
      dashboard={{
        asOf: emptyTable.asOf,
        environment: 'test',
        metrics: [
          { key: 'profit', label: '贡献毛利', value: null, kind: 'cny', note: '成本尚未对账' },
        ],
        alerts: emptyTable,
        notices: [],
      }}
    />,
  );
  expect(screen.getByText('成本尚未对账')).toBeInTheDocument();
  expect(screen.getByText('暂不可用')).toBeInTheDocument();
  expect(screen.queryByText('¥0.00')).not.toBeInTheDocument();
});
it('shows navigation based on actual permissions rather than role names', () => {
  expect(availableNavigation(actor).map((item) => item.path)).toContain('/users');
  expect(availableNavigation(actor).map((item) => item.path)).not.toContain('/models');
  expect(
    availableNavigation({ ...actor, roles: ['owner'], permissions: ['models.read'] }).map(
      (item) => item.path,
    ),
  ).toEqual(['/models']);
});
it('renders the native matrix and leaves missing cells unsupported', () => {
  render(
    <ModelSpecs
      table={{
        ...emptyTable,
        title: '规格',
        rows: [
          {
            id: '1',
            resolution: '1K',
            ratio: '1:1',
            width: 1024,
            height: 1024,
            enabled: true,
            credits: '10',
          },
          {
            id: '2',
            resolution: '2K',
            ratio: '16:9',
            width: 2048,
            height: 1152,
            enabled: false,
            credits: null,
          },
        ],
      }}
    />,
  );
  expect(screen.getByText('1024 × 1024')).toBeInTheDocument();
  expect(screen.getByText('2048 × 1152')).toBeInTheDocument();
  expect(screen.getAllByText('不支持')).toHaveLength(2);
  expect(screen.getByText('未启用')).toBeInTheDocument();
});
it('paginates from server cursors and resets the page for exact search', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      json({ ...emptyTable, title: '用户', rows: [{ id: 'first' }], nextCursor: 'next-value' }),
    )
    .mockResolvedValueOnce(json({ ...emptyTable, title: '用户', rows: [{ id: 'second' }] }))
    .mockResolvedValueOnce(json({ ...emptyTable, title: '用户', rows: [] }));
  vi.stubGlobal('fetch', fetcher);
  render(<ResourcePage path="/users" client={new AdminClient()} permissions={actor.permissions} />);
  await screen.findByText('first');
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  await screen.findByText('second');
  expect(fetcher.mock.calls[1][0]).toContain('cursor=next-value');
  fireEvent.change(screen.getByLabelText('精确搜索'), { target: { value: 'person@example.test' } });
  fireEvent.click(screen.getByRole('button', { name: '查询' }));
  await screen.findByText('没有符合条件的记录');
  expect(fetcher.mock.calls[2][0]).toContain('q=person%40example.test');
  expect(fetcher.mock.calls[2][0]).not.toContain('cursor=');
});
it('does not reveal the previous resource while the next request loads', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(json({ ...emptyTable, rows: [{ id: 'private-user' }] }))
    .mockImplementationOnce(() => new Promise(() => {}));
  vi.stubGlobal('fetch', fetcher);
  const client = new AdminClient();
  const view = render(
    <ResourcePage path="/users" client={client} permissions={actor.permissions} />,
  );
  await screen.findByText('private-user');
  view.rerender(<ResourcePage path="/orders" client={client} permissions={actor.permissions} />);
  expect(screen.queryByText('private-user')).not.toBeInTheDocument();
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
});

it('supports scoped job filters without putting a prompt in the query', async () => {
  const fetcher = vi.fn().mockImplementation(() => Promise.resolve(json(emptyTable)));
  vi.stubGlobal('fetch', fetcher);
  render(<ResourcePage path="/jobs" client={new AdminClient()} permissions={actor.permissions} />);
  await screen.findByText('没有符合条件的记录');
  fireEvent.change(screen.getByLabelText('用户 ID'), {
    target: { value: '6cfa1770-9a1b-4d82-937a-f29d9360f508' },
  });
  fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'official-model' } });
  fireEvent.click(screen.getByRole('button', { name: '查询' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(fetcher.mock.calls[1][0]).toContain('userId=6cfa1770-9a1b-4d82-937a-f29d9360f508');
  expect(fetcher.mock.calls[1][0]).toContain('modelId=official-model');
  expect(fetcher.mock.calls[1][0]).not.toContain('prompt');
});
