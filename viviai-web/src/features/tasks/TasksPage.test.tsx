import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { api } from '@/src/services/api';
import { mutateDb, resetDb, settleTask } from '@/src/mocks/db';
import { server } from '@/src/mocks/server';
import { TasksPage } from './TasksPage';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => resetDb());
afterEach(() => cleanup());
afterAll(() => server.close());

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/tasks']}>
        <TasksPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function balance(): Promise<number> {
  const me = await api.getMe();
  if (!me) throw new Error('expected a signed-in session');
  return me.credits;
}

/** Submits a two-row batch through the same quote-then-run commands the editor uses. */
async function submitBatch() {
  const workflow = await api.createWorkflow({
    name: '商品批量主图',
    columns: [
      { id: 'ref', name: '商品素材', type: 'reference' },
      { id: 'out', name: '主图', type: 'generation', prompt: '商业主图', sourceColumnIds: ['ref'], modelId: 'nano-banana-2', resolution: '1K', ratio: '1:1' },
    ],
    rows: [1, 2].map((index) => ({ rowKey: `row-${index}`, cells: { ref: `asset-${index}` } })),
  });
  const quote = await api.quoteWorkflowRun({ workflowId: workflow.id, rowIds: workflow.rows.map((row) => row.rowKey) });
  return api.submitWorkflowRun(quote.quoteId!, crypto.randomUUID());
}

describe('task center batches', () => {
  it('lists each batch with its progress and opens the per-item detail', async () => {
    const user = userEvent.setup();
    await submitBatch();
    renderPage();

    expect(await screen.findByRole('heading', { name: '商品批量主图' })).toBeVisible();
    expect(screen.getByText('2 个任务 · 已扣 0 / 预计 8 积分')).toBeVisible();
    expect(screen.getByText('批次排队中')).toBeVisible();

    await user.click(screen.getByRole('button', { name: '查看详情' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/版本 1 · 批次排队中/)).toBeVisible();
    expect(within(dialog).getAllByText('主图')).toHaveLength(2);
  });

  it('cancels the remaining tasks of a running batch and returns the frozen credits', async () => {
    const user = userEvent.setup();
    const credits = await balance();
    const run = await submitBatch();
    expect(await balance()).toBe(credits - 8);
    renderPage();

    await user.click(await screen.findByRole('button', { name: '取消剩余任务' }));

    await waitFor(async () => expect((await api.getWorkflowRun(run.id)).status).toBe('cancelled'));
    expect(await screen.findByText('批次已取消')).toBeVisible();
    expect(screen.queryByRole('button', { name: '取消剩余任务' })).not.toBeInTheDocument();
    expect(await balance()).toBe(credits);
  });

  it('retries only the failed items once a fresh quote is confirmed', async () => {
    const user = userEvent.setup();
    const run = await submitBatch();
    const [first, second] = run.items;
    settleTask(first!.generationJobId, 'success');
    settleTask(second!.generationJobId, 'failure');
    renderPage();

    expect(await screen.findByText('批次部分成功')).toBeVisible();
    expect(screen.getByText('2 个任务 · 已扣 4 / 预计 8 积分')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '重试失败项' }));

    // Retry always re-quotes: only the failed item is priced.
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('确认重试失败项')).toBeVisible();
    expect(within(dialog).getAllByText('主图')).toHaveLength(1);
    expect(within(dialog).getByTestId('quote-total')).toHaveTextContent('4 积分');
    await user.click(within(dialog).getByRole('button', { name: '确认重试' }));

    await waitFor(async () => expect(await api.listWorkflowRuns()).toHaveLength(2));
    const retry = (await api.listWorkflowRuns()).find((item) => item.retryOfRunId === run.id)!;
    expect(retry).toMatchObject({ totalCount: 1, estimatedCredits: 4 });
    expect((await api.getWorkflowRun(run.id)).retryRunIds).toEqual([retry.id]);
  });

  it('hides retry when the server marks every failure non-retryable', async () => {
    const run = await submitBatch();
    for (const item of run.items) settleTask(item.generationJobId, 'failure');
    mutateDb((draft) => {
      for (const item of draft.workflowRuns.find((candidate) => candidate.id === run.id)!.items) {
        const task = draft.tasks.find((candidate) => candidate.id === item.generationJobId);
        // MODEL_UNAVAILABLE is one of the failure codes the server reports as non-retryable.
        if (task) task.errorCode = 'MODEL_UNAVAILABLE';
      }
    });
    renderPage();

    expect(await screen.findByText('批次失败')).toBeVisible();
    expect(screen.queryByRole('button', { name: '重试失败项' })).not.toBeInTheDocument();
  });
});
