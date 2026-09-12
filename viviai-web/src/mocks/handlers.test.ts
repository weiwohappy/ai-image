import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { api } from '@/src/services/api';
import type { GenerationInput, RemixInput, Workflow } from '@/src/types/domain';
import { loadDb, mutateDb, resetDb, settleTask } from './db';
import { saveReferenceUpload } from './referenceUploads';
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

  it('migrates a legacy active task by failing it and refunding frozen credits', async () => {
    const created = await api.createGenerationTask(baseInput, 'slow');
    mutateDb((draft) => {
      const task = draft.tasks.find((item) => item.id === created.id);
      if (task) delete task.mockLifecycle;
    });

    const migrated = (await api.listGenerationTasks()).find((item) => item.id === created.id);
    expect(migrated).toMatchObject({ status: 'failed', errorCode: 'INTERNAL_ERROR' });
    await expect(api.getMe()).resolves.toMatchObject({ credits: 1120, frozenCredits: 0 });
  });
});

describe('User supplied remix reference', () => {
  const input: RemixInput = { modelId: 'nano-banana-2', resolution: '1K', ratio: '1:1', count: 1, adaptation: '保留暖色光影，替换为我的咖啡礼盒', strength: 'balanced' };

  it('rejects missing and unknown references without freezing credits', async () => {
    await expect(api.createRemixTask(input)).rejects.toMatchObject({ code: 'ASSET_INVALID' });
    await expect(api.createRemixTask({ ...input, referenceAssetId: 'missing-image' })).rejects.toMatchObject({ code: 'ASSET_INVALID' });
    await expect(api.getMe()).resolves.toMatchObject({ credits: 1120, frozenCredits: 0 });
    expect(loadDb().tasks).toHaveLength(0);
  });

  it('passes the uploaded reference first and the optional subject second without a template', async () => {
    const reference = saveReferenceUpload(new File(['reference'], 'reference.png', { type: 'image/png' }), 800, 600);
    const subject = saveReferenceUpload(new File(['subject'], 'subject.png', { type: 'image/png' }), 600, 600);
    const task = await api.createRemixTask({ ...input, referenceAssetId: reference.id, subjectAssetId: subject.id });
    expect(task.input).toMatchObject({ referenceAssetId: reference.id, referenceAssetIds: [reference.id, subject.id], source: 'remix', prompt: input.adaptation });
    expect(task.templateId).toBeUndefined();
    expect(task.remixStrength).toBe('balanced');
    settleTask(task.id, 'success');
    expect(loadDb().assets.find((asset) => asset.id === `asset-${task.id}-1`)).toMatchObject({ source: 'remix' });
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
    const children = tasks.filter((task) => batch.childTaskIds.includes(task.id));
    expect(children).toHaveLength(2);
    expect(children[0]).toMatchObject({ workflowId: saved.id, workflowRowId: expect.any(String), workflowColumnId: 'output' });
    expect(children[0].input.referenceAssetIds).toHaveLength(2);

    settleTask(batch.childTaskIds[0], 'success');
    settleTask(batch.childTaskIds[1], 'failure');
    expect((await api.listBatches())[0]).toMatchObject({ status: 'partial', completed: 1, processing: 0, failed: 1 });
    expect((await api.listAssets()).some((asset) => asset.source === 'workflow')).toBe(true);
    const completedWorkflow = await api.getWorkflow(saved.id);
    expect(completedWorkflow.rows[0]).toMatchObject({ status: 'succeeded', cells: { output: expect.stringMatching(/^asset-task-/) } });
    expect(completedWorkflow.rows[1]).toMatchObject({ status: 'failed' });
    await expect(api.getMe()).resolves.toMatchObject({ credits: 1116, frozenCredits: 0 });

    const rerun = await api.runWorkflow(saved.id, ['row-2']);
    expect(rerun.childTaskIds).toHaveLength(1);
    expect((await api.listGenerationTasks()).find((task) => task.id === rerun.childTaskIds[0])).toMatchObject({ batchId: rerun.id });
    settleTask(rerun.childTaskIds[0], 'success');
    const rerunWorkflow = await api.getWorkflow(saved.id);
    expect(rerunWorkflow.rows[1]).toMatchObject({ status: 'succeeded', cells: { output: expect.stringMatching(/^asset-task-/) } });
    await expect(api.getMe()).resolves.toMatchObject({ credits: 1112, frozenCredits: 0 });
  });

  it('rejects private endpoints after logout', async () => {
    await api.logout();
    await expect(api.listAssets()).rejects.toEqual(expect.objectContaining({ code: 'AUTH_REQUIRED', status: 401 }));
    await expect(api.listGenerationTasks()).rejects.toEqual(expect.objectContaining({ code: 'AUTH_REQUIRED', status: 401 }));
  });

  it('replays a redemption for the same idempotency key and rejects a conflicting payload', async () => {
    await expect(api.redeemCode('viviai2026', 'mock-redeem-attempt-1')).resolves.toMatchObject({ credits: 1220 });
    await expect(api.redeemCode('VIVIAI2026', 'mock-redeem-attempt-1')).resolves.toMatchObject({ credits: 1220 });
    await expect(api.redeemCode('OTHER', 'mock-redeem-attempt-1')).rejects.toEqual(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT', status: 409 }));
    expect(loadDb().ledger.filter((entry) => entry.type === 'redeem')).toHaveLength(1);
  });

  it('binds a valid invitation reward and rejects an unknown invitation', async () => {
    await api.sendCode('invited@example.com', 'register');
    await expect(api.register({ username: '邀请用户', email: 'invited@example.com', password: 'registration-12', code: '123456', inviteCode: 'VIVI-MIA88' })).resolves.toMatchObject({ credits: 105 });
    expect(loadDb().ledger).toContainEqual(expect.objectContaining({ type: 'invite', delta: 100 }));

    resetDb();
    await api.sendCode('unknown@example.com', 'register');
    await expect(api.register({ username: '未知邀请', email: 'unknown@example.com', password: 'registration-12', code: '123456', inviteCode: 'UNKNOWN-CODE' })).rejects.toEqual(expect.objectContaining({ code: 'INVALID_INVITE_CODE', status: 422 }));
  });

  it('isolates verification code purposes and consumes each code once', async () => {
    await api.sendCode('next@example.com', 'change-email');
    await expect(api.changePassword({ code: '123456', password: 'password-long-12' })).rejects.toEqual(expect.objectContaining({ code: 'INVALID_INPUT' }));
    await expect(api.changeEmail({ email: 'next@example.com', code: '123456' })).resolves.toMatchObject({ email: 'next@example.com' });
    await expect(api.changeEmail({ email: 'again@example.com', code: '123456' })).rejects.toEqual(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });

  it('requires a 12-character password without consuming a verification code first', async () => {
    await api.sendCode('demo@viviai.local', 'change-password');
    await expect(api.changePassword({ code: '123456', password: 'short-pass1' })).rejects.toEqual(expect.objectContaining({ code: 'INVALID_INPUT' }));
    await expect(api.changePassword({ code: '123456', password: 'password-long-12' })).resolves.toMatchObject({ id: 'user-demo' });
  });

  it('supports login after registration and after changing email and password', async () => {
    const priorUserId = loadDb().user.id;
    mutateDb((draft) => {
      draft.user.avatarUrl = 'data:image/png;base64,old-avatar';
      draft.user.inviteCode = 'OLD-CODE';
      draft.inspirations[0].liked = true;
      draft.templates[0].favorite = true;
    });
    await api.sendCode('new@example.com', 'register');
    await api.register({ username: '新用户', email: 'new@example.com', password: 'initial-password-88', code: '123456' });
    const registered = loadDb();
    expect(registered.user).toMatchObject({ username: '新用户', email: 'new@example.com', planId: 'free', credits: 5 });
    expect(registered.user.id).not.toBe(priorUserId);
    expect(registered.user.avatarUrl).toBeUndefined();
    expect(registered.user.inviteCode).not.toBe('OLD-CODE');
    expect(registered.inspirations.every((item) => !item.liked)).toBe(true);
    expect(registered.templates.every((item) => !item.favorite)).toBe(true);
    expect(JSON.parse(window.localStorage.getItem('viviai-mock-db-v1') ?? '{}')).not.toHaveProperty('credentialHash');
    await api.logout();
    await expect(api.login({ account: 'new@example.com', password: 'initial-password-88' })).resolves.toMatchObject({ username: '新用户' });

    await api.sendCode('changed@example.com', 'change-email');
    await api.changeEmail({ email: 'changed@example.com', code: '123456' });
    await api.sendCode('changed@example.com', 'change-password');
    await api.changePassword({ code: '123456', password: 'changed-password-88' });
    await api.logout();
    await expect(api.login({ account: 'new@example.com', password: 'initial-password-88' })).rejects.toEqual(expect.objectContaining({ code: 'INVALID_CREDENTIALS' }));
    await expect(api.login({ account: 'changed@example.com', password: 'changed-password-88' })).resolves.toMatchObject({ email: 'changed@example.com' });
  });
});
