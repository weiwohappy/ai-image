import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { api } from '@/src/services/api';
import type { GenerationInput, Workflow } from '@/src/types/domain';
import { loadDb, mutateDb, resetDb, settleTask } from './db';
import { server } from './server';

const baseInput: GenerationInput = {
  prompt: '透明香氛瓶，暖色电影光',
  modelId: 'nano-banana-2',
  resolution: '1K',
  ratio: '1:1',
  count: 1,
};

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => resetDb());
afterAll(() => server.close());

describe('Mock generation state machine', () => {
  it('freezes credits when queued and creates a charged asset after success', async () => {
    const created = await api.createGenerationTask(baseInput);

    expect(created.status).toBe('queued');
    expect(created.estimatedCredits).toBe(4);
    await expect(api.getMe()).resolves.toMatchObject({ credits: 1116, frozenCredits: 4 });

    settleTask(created.id, 'success');
    const task = (await api.listGenerationTasks()).find((item) => item.id === created.id);
    expect(task).toMatchObject({ status: 'succeeded', chargedCredits: 4 });
    expect(task?.resultAssetIds).toHaveLength(1);
    await expect(api.getMe()).resolves.toMatchObject({ credits: 1116, frozenCredits: 0 });
    expect((await api.listAssets()).find((asset) => asset.id === task?.resultAssetIds[0])).toMatchObject({ source: 'generation' });
  });

  it('refunds all credits on failure and records the refund', async () => {
    const created = await api.createGenerationTask({ ...baseInput, count: 2 });
    settleTask(created.id, 'failure');

    await expect(api.getMe()).resolves.toMatchObject({ credits: 1120, frozenCredits: 0 });
    expect((await api.listGenerationTasks())[0]).toMatchObject({ status: 'failed', chargedCredits: 0 });
    expect((await api.listPointLedger())[0]).toMatchObject({ type: 'refund', delta: 8 });
  });

  it('charges only successful images after partial completion', async () => {
    const created = await api.createGenerationTask({ ...baseInput, count: 2 });
    settleTask(created.id, 'partial');

    await expect(api.getMe()).resolves.toMatchObject({ credits: 1116, frozenCredits: 0 });
    expect((await api.listGenerationTasks())[0]).toMatchObject({ status: 'partial', chargedCredits: 4 });
    expect((await api.listGenerationTasks())[0].resultAssetIds).toHaveLength(1);
  });

  it('refunds and logs a cancellation exactly once', async () => {
    const created = await api.createGenerationTask(baseInput);
    await api.cancelGenerationTask(created.id);
    await api.cancelGenerationTask(created.id);

    await expect(api.getMe()).resolves.toMatchObject({ credits: 1120, frozenCredits: 0 });
    expect((await api.listPointLedger()).filter((entry) => entry.description === '任务取消退回')).toHaveLength(1);
  });

  it('reconciles a persisted active task after its lifecycle deadline', async () => {
    const created = await api.createGenerationTask(baseInput, 'slow');
    mutateDb((draft) => {
      const task = draft.tasks.find((item) => item.id === created.id);
      if (task?.mockLifecycle) task.mockLifecycle.completionAt = new Date(Date.now() - 1000).toISOString();
    });

    expect((await api.listGenerationTasks()).find((item) => item.id === created.id)?.status).toBe('succeeded');
    await expect(api.getMe()).resolves.toMatchObject({ frozenCredits: 0 });
  });
});

describe('Mock workflow and account boundaries', () => {
  it('creates real workflow child tasks and derives batch totals from their outcomes', async () => {
    const workflow: Workflow = {
      id: 'workflow-test',
      name: '批量主图',
      version: 0,
      saved: false,
      updatedAt: new Date().toISOString(),
      columns: [
        { id: 'reference', name: '商品素材', type: 'reference' },
        { id: 'style', name: '风格素材', type: 'reference' },
        { id: 'output', name: '主图', type: 'generation', prompt: '商业主图', sourceColumnIds: ['reference', 'style'], modelId: 'nano-banana-2', resolution: '1K', ratio: '1:1' },
      ],
      rows: [
        { id: 'row-1', selected: true, status: 'idle', cells: { reference: 'asset-1', style: 'asset-2' } },
        { id: 'row-2', selected: true, status: 'idle', cells: { reference: 'asset-3', style: 'asset-4' } },
      ],
    };
    const saved = await api.saveWorkflow(workflow);
    const batch = await api.runWorkflow(saved.id, ['row-1', 'row-2']);

    expect(batch).toMatchObject({ total: 2, processing: 2, estimatedCredits: 8 });
    expect(batch.childTaskIds).toHaveLength(2);
    await expect(api.getMe()).resolves.toMatchObject({ credits: 1112, frozenCredits: 8 });
    const tasks = await api.listGenerationTasks();
    expect(tasks.filter((task) => batch.childTaskIds.includes(task.id))).toHaveLength(2);

    settleTask(batch.childTaskIds[0], 'success');
    settleTask(batch.childTaskIds[1], 'failure');
    expect((await api.listBatches())[0]).toMatchObject({ status: 'partial', completed: 1, processing: 0, failed: 1 });
    expect((await api.listAssets()).some((asset) => asset.source === 'workflow')).toBe(true);
    await expect(api.getMe()).resolves.toMatchObject({ credits: 1116, frozenCredits: 0 });
  });

  it('rejects private endpoints after logout', async () => {
    await api.logout();
    await expect(api.listAssets()).rejects.toEqual(expect.objectContaining({ code: 'AUTH_REQUIRED', status: 401 }));
    await expect(api.listGenerationTasks()).rejects.toEqual(expect.objectContaining({ code: 'AUTH_REQUIRED', status: 401 }));
  });

  it('redeems a code only once', async () => {
    await expect(api.redeemCode('viviai2026')).resolves.toMatchObject({ credits: 1220 });
    await expect(api.redeemCode('VIVIAI2026')).rejects.toEqual(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(loadDb().ledger.filter((entry) => entry.type === 'redeem')).toHaveLength(1);
  });
});
