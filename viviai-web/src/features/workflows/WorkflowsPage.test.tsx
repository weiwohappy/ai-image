import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { api } from '@/src/services/api';
import { resetDb } from '@/src/mocks/db';
import { server } from '@/src/mocks/server';
import { WorkflowsPage } from './WorkflowsPage';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => resetDb());
afterEach(() => cleanup());
afterAll(() => server.close());

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/workflows']}>
        <WorkflowsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('workflows list', () => {
  it('lists the workflows the server reports', async () => {
    await api.createWorkflow({
      name: '商品批量主图',
      columns: [
        { id: 'ref', name: '商品素材', type: 'reference' },
        { id: 'out', name: '主图', type: 'generation', prompt: '商业主图', sourceColumnIds: ['ref'], modelId: 'nano-banana-2', resolution: '1K', ratio: '1:1' },
      ],
      rows: [{ rowKey: 'row-1', cells: {} }],
    });
    renderPage();

    expect(await screen.findByRole('heading', { name: '商品批量主图' })).toBeVisible();
    expect(screen.getByText(/1 行 · 2 列 · 版本 1/)).toBeVisible();
  });

  it('offers the empty state when the account has no workflows', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: '创建你的第一个批量工作流' })).toBeVisible();
  });

  it('copies a workflow as a new server-side workflow', async () => {
    const user = userEvent.setup();
    await api.createWorkflow({ name: '待复制工作流', columns: [{ id: 'ref', name: '商品素材', type: 'reference' }], rows: [{ rowKey: 'row-1', cells: {} }] });
    renderPage();

    await user.click(await screen.findByRole('button', { name: '复制' }));

    await waitFor(async () => expect((await api.listWorkflows()).map((item) => item.name)).toContain('待复制工作流（副本）'));
  });

  it('archives a workflow through the server', async () => {
    const user = userEvent.setup();
    const source = await api.createWorkflow({ name: '待归档工作流', columns: [{ id: 'ref', name: '商品素材', type: 'reference' }], rows: [{ rowKey: 'row-1', cells: {} }] });
    renderPage();

    await user.click(await screen.findByRole('button', { name: '归档 待归档工作流' }));

    await waitFor(async () => expect((await api.listWorkflows()).map((item) => item.id)).not.toContain(source.id));
    expect(await screen.findByRole('heading', { name: '创建你的第一个批量工作流' })).toBeVisible();
  });
});
