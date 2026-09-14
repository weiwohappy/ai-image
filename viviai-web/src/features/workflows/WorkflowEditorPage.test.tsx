import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { api } from '@/src/services/api';
import { resetDb } from '@/src/mocks/db';
import { server } from '@/src/mocks/server';
import { WorkflowEditorPage } from './WorkflowEditorPage';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => resetDb());
afterEach(() => cleanup());
afterAll(() => server.close());

function renderEditor(path = '/workflows/new') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/workflows/:workflowId" element={<WorkflowEditorPage />} />
          <Route path="/tasks" element={<h1>任务中心</h1>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function saveNewWorkflow() {
  await screen.findByRole('button', { name: /运行所选/ });
  await userEvent.setup().click(screen.getByRole('button', { name: '保存' }));
  await screen.findByText(/已保存 · 版本 1/);
  return (await api.listWorkflows())[0];
}

type User = ReturnType<typeof userEvent.setup>;

/** A saved workflow a second session can bump underneath the editor. */
const seedDefinition = {
  name: '商品批量主图',
  columns: [
    { id: 'reference', name: '商品素材', type: 'reference' as const },
    { id: 'generation', name: '主图生成', type: 'generation' as const, prompt: '商业主图', sourceColumnIds: ['reference'], modelId: 'nano-banana-2', resolution: '1K' as const, ratio: '1:1' as const },
  ],
  rows: [{ rowKey: 'row-1', cells: { reference: 'asset-1' } }],
};

/** Types a local edit so the draft is ours before the server moves on. */
async function renameLocally(user: User, name: string) {
  await user.clear(screen.getByLabelText('工作流名称'));
  await user.type(screen.getByLabelText('工作流名称'), name);
}

/** Both reference columns feed the generation column, so a row is only runnable once both hold an asset. */
async function fillReferences(user: User, rows: number[] = [1, 2]) {
  await screen.findAllByRole('option', { name: '琥珀香氛主视觉' });
  for (const row of rows) {
    await user.selectOptions(screen.getByLabelText(`商品素材第 ${row} 行`), `asset-${row}`);
    await user.selectOptions(screen.getByLabelText(`风格参考第 ${row} 行`), `asset-${row + 3}`);
  }
}

describe('workflow editor', () => {
  it('requires a save before selected rows can run', async () => {
    const user = userEvent.setup();
    renderEditor();

    const run = await screen.findByRole('button', { name: '运行所选 2 个任务' });
    expect(run).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText(/已保存 · 版本 1/)).toBeVisible();
    expect(screen.getByRole('button', { name: '运行所选 2 个任务' })).toBeEnabled();
  });

  it('starts a new workflow with empty reference cells and catalog model defaults', async () => {
    renderEditor();
    const saved = await saveNewWorkflow();

    expect(saved.rows).toHaveLength(3);
    for (const row of saved.rows) expect(row.cells).toEqual({});
    // Defaults come from the live catalog rather than a hard-coded model.
    const catalog = await api.listModels();
    const model = catalog.find((item) => item.status === 'available')!;
    const generation = saved.columns.find((column) => column.type === 'generation');
    expect(generation).toMatchObject({ modelId: model.id, resolution: model.resolutions[0], ratio: model.ratios[0] });
    expect(generation?.modelId).not.toBe('nano-banana-2-lite');
    expect(screen.getByLabelText('商品素材第 1 行')).toHaveValue('');
  });

  it('reloads a saved workflow into the grid with its server identity', async () => {
    renderEditor();
    const saved = await saveNewWorkflow();
    cleanup();
    renderEditor(`/workflows/${saved.id}`);

    expect(await screen.findByDisplayValue(saved.name)).toBeVisible();
    expect(await screen.findByText(`已保存 · 版本 ${saved.version}`)).toBeVisible();
  });

  it('keeps the local draft and offers both resolutions on a version conflict', async () => {
    const user = userEvent.setup();
    const workflow = await api.createWorkflow(seedDefinition);
    renderEditor(`/workflows/${workflow.id}`);
    await screen.findByText('已保存 · 版本 1');

    // Another session saves a newer version while our local edit is still unsaved.
    await renameLocally(user, '本地草稿');
    await api.updateWorkflow(workflow.id, { ...seedDefinition, name: '服务端新版本', version: 1 });
    await user.click(screen.getByRole('button', { name: '保存' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('工作流已被其他改动更新')).toBeVisible();
    expect(within(dialog).getByRole('button', { name: '重新加载服务端版本' })).toBeVisible();
    expect(within(dialog).getByRole('button', { name: '保留本地内容供复制' })).toBeVisible();
    // The local draft survives the conflict instead of being silently discarded.
    expect(screen.getByDisplayValue('本地草稿')).toBeVisible();
  });

  it('reloads the server version when the conflict dialog asks for it', async () => {
    const user = userEvent.setup();
    const workflow = await api.createWorkflow(seedDefinition);
    renderEditor(`/workflows/${workflow.id}`);
    await screen.findByText('已保存 · 版本 1');
    await renameLocally(user, '本地草稿');
    await api.updateWorkflow(workflow.id, { ...seedDefinition, name: '服务端新版本', version: 1 });
    await user.click(screen.getByRole('button', { name: '保存' }));
    await user.click(await screen.findByRole('button', { name: '重新加载服务端版本' }));

    expect(await screen.findByDisplayValue('服务端新版本')).toBeVisible();
  });

  it('saves the local draft as a copy when the conflict dialog asks for it', async () => {
    const user = userEvent.setup();
    const workflow = await api.createWorkflow(seedDefinition);
    renderEditor(`/workflows/${workflow.id}`);
    await screen.findByText('已保存 · 版本 1');
    await renameLocally(user, '本地草稿');
    await api.updateWorkflow(workflow.id, { ...seedDefinition, name: '服务端新版本', version: 1 });
    await user.click(screen.getByRole('button', { name: '保存' }));
    await user.click(await screen.findByRole('button', { name: '保留本地内容供复制' }));

    // The unsaved edit lands in a new workflow instead of being lost.
    await waitFor(async () => expect((await api.listWorkflows()).map((item) => item.name)).toContain('本地草稿'));
    expect((await api.listWorkflows()).find((item) => item.name === '服务端新版本')).toBeDefined();
  });

  it('shows the server quote per item and in total before submitting', async () => {
    const user = userEvent.setup();
    renderEditor();
    await fillReferences(user);
    await saveNewWorkflow();

    await user.click(screen.getByRole('button', { name: '运行所选 2 个任务' }));

    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('确认批量生成')).toBeVisible();
    expect(within(dialog).getByTestId('quote-total')).toHaveTextContent('8 积分');
    // One priced row per selected row, each carrying its own unit price.
    expect(within(dialog).getAllByText('主图生成')).toHaveLength(2);
    expect(within(dialog).getAllByText('4 积分')).toHaveLength(2);
    expect(within(dialog).getByRole('button', { name: '确认生成' })).toBeEnabled();
  });

  it('maps a missing reference cell to a per-item error that blocks submission', async () => {
    const user = userEvent.setup();
    renderEditor();
    // Only the first row gets its references; the second stays empty.
    await fillReferences(user, [1]);
    await saveNewWorkflow();

    await user.click(screen.getByRole('button', { name: '运行所选 2 个任务' }));

    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findAllByText('该单元格还没有选择参考图。')).toHaveLength(1);
    expect(within(dialog).getByText(/有 1 项无法运行/)).toBeVisible();
    expect(within(dialog).getByTestId('quote-total')).toHaveTextContent('0 积分');
    expect(within(dialog).getByRole('button', { name: '确认生成' })).toBeDisabled();
  });

  it('submits the confirmed quote and lands on the task center', async () => {
    const user = userEvent.setup();
    renderEditor();
    await fillReferences(user);
    const saved = await saveNewWorkflow();

    await user.click(screen.getByRole('button', { name: '运行所选 2 个任务' }));
    await user.click(await screen.findByRole('button', { name: '确认生成' }));

    expect(await screen.findByRole('heading', { name: '任务中心' })).toBeVisible();
    const runs = await api.listWorkflowRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ workflowId: saved.id, totalCount: 2, estimatedCredits: 8 });
  });

  it('reports the latest run progress for this workflow', async () => {
    const user = userEvent.setup();
    renderEditor();
    await fillReferences(user);
    const saved = await saveNewWorkflow();
    await user.click(screen.getByRole('button', { name: '运行所选 2 个任务' }));
    await user.click(await screen.findByRole('button', { name: '确认生成' }));
    await screen.findByRole('heading', { name: '任务中心' });

    cleanup();
    renderEditor(`/workflows/${saved.id}`);

    // Both rows are one generation each, so a settled batch is 2 succeeded for 4+4 credits.
    const progress = await screen.findByTestId('run-progress');
    await waitFor(() => expect(progress).toHaveTextContent('最近批次：成功 2 · 失败 0 · 已扣 8 积分'), { timeout: 5000 });
  });

  it('invalidates the quote when the selection changes underneath it', async () => {
    const user = userEvent.setup();
    renderEditor();
    await fillReferences(user);
    await saveNewWorkflow();
    await user.click(screen.getByRole('button', { name: '运行所选 2 个任务' }));

    const dialog = await screen.findByRole('dialog');
    const confirm = await within(dialog).findByRole('button', { name: '确认生成' });
    expect(confirm).toBeEnabled();

    await user.click(screen.getByLabelText('选择第 3 行'));
    expect(await within(dialog).findByText('工作流或所选行已变更，请重新报价后再确认。')).toBeVisible();
    expect(confirm).toBeDisabled();

    // Restoring the quoted selection makes the same quote usable again.
    await user.click(screen.getByLabelText('选择第 3 行'));
    await waitFor(() => expect(confirm).toBeEnabled());
  });
});
