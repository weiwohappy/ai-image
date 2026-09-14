import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { api } from '@/src/services/api';
import type { GenerationTask, WorkflowDefinition } from '@/src/types/domain';
import { getCredentialHash, loadDb, mutateDb, resetDb, settleTask } from './db';
import { saveReferenceUpload } from './referenceUploads';
import { server } from './server';

/** The generation request exactly as the console submits it to the backend. */
interface WireInput {
  source: 'create' | 'remix';
  prompt: string;
  modelId: string;
  resolution: string;
  ratio: string;
  format: 'png';
  quality: 'standard';
  count: number;
  referenceAssetId?: string;
  subjectAssetId?: string;
  strength?: 'similar' | 'balanced' | 'creative';
  templateId?: string;
  templateVersion?: number;
}

const baseInput: WireInput = {
  source: 'create',
  prompt: '透明香氛瓶，暖色电影光',
  modelId: 'nano-banana-2',
  resolution: '1K',
  ratio: '1:1',
  format: 'png',
  quality: 'standard',
  count: 1,
};

/** Quotes and submits one task the way `createGeneration` does. */
async function generate(input: WireInput, key = 'generation-key-0001'): Promise<GenerationTask> {
  const quote = await api.createGenerationQuote(input);
  return api.submitGenerationTask('generation', quote.id, input, key);
}

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => resetDb());
afterAll(() => server.close());

describe('Mock generation state machine', () => {
  it('freezes credits when queued and creates a charged asset after success', async () => {
    const created = await generate(baseInput);

    expect(created.status).toBe('queued');
    expect(created.estimatedCredits).toBe(4);
    expect(created.input).toMatchObject({ source: 'generation', modelId: 'nano-banana-2', count: 1 });
    await expect(api.getMe()).resolves.toMatchObject({ credits: 1116, frozenCredits: 4 });

    settleTask(created.id, 'success');
    const task = (await api.listGenerationTasks()).find((item) => item.id === created.id);
    expect(task).toMatchObject({ status: 'succeeded', chargedCredits: 4 });
    expect(task?.resultAssetIds).toHaveLength(1);
    await expect(api.getMe()).resolves.toMatchObject({ credits: 1116, frozenCredits: 0 });
    expect((await api.listAssets()).find((asset) => asset.id === task?.resultAssetIds[0])).toMatchObject({ source: 'generation' });
  });

  it('prices without charging, then consumes the quote exactly once', async () => {
    const quote = await api.createGenerationQuote({ ...baseInput, count: 2 });

    expect(quote).toMatchObject({ unitCredits: 4, totalCredits: 8, priceVersion: null });
    await expect(api.getMe()).resolves.toMatchObject({ credits: 1120, frozenCredits: 0 });

    await api.submitGenerationTask('generation', quote.id, { ...baseInput, count: 2 }, 'consume-key-0001');
    await expect(api.getMe()).resolves.toMatchObject({ credits: 1112, frozenCredits: 8 });
    await expect(api.submitGenerationTask('generation', quote.id, { ...baseInput, count: 2 }, 'consume-key-0002')).rejects.toEqual(expect.objectContaining({ code: 'QUOTE_USED', status: 409 }));
  });

  it('replays a submission for the same idempotency key instead of charging twice', async () => {
    const quote = await api.createGenerationQuote(baseInput);
    const first = await api.submitGenerationTask('generation', quote.id, baseInput, 'replay-key-0001');
    const replayed = await api.submitGenerationTask('generation', quote.id, baseInput, 'replay-key-0001');

    expect(replayed.id).toBe(first.id);
    expect(loadDb().tasks).toHaveLength(1);
    await expect(api.getMe()).resolves.toMatchObject({ credits: 1116, frozenCredits: 4 });
  });

  it('refuses a submission whose input no longer prices the same as its quote', async () => {
    const quote = await api.createGenerationQuote(baseInput);

    await expect(api.submitGenerationTask('generation', quote.id, { ...baseInput, count: 2 }, 'drift-key-0001')).rejects.toEqual(expect.objectContaining({ code: 'QUOTE_MISMATCH', status: 409 }));
    await expect(api.getMe()).resolves.toMatchObject({ credits: 1120, frozenCredits: 0 });
  });

  it('refuses an unknown quote and a missing idempotency key', async () => {
    await expect(api.submitGenerationTask('generation', 'quote-missing', baseInput, 'unknown-key-0001')).rejects.toEqual(expect.objectContaining({ code: 'QUOTE_NOT_FOUND', status: 404 }));
    const quote = await api.createGenerationQuote(baseInput);
    await expect(api.submitGenerationTask('generation', quote.id, baseInput, 'short')).rejects.toEqual(expect.objectContaining({ code: 'INVALID_INPUT', status: 400 }));
  });

  it('refunds all credits on failure and records the refund', async () => {
    const created = await generate({ ...baseInput, count: 2 });
    settleTask(created.id, 'failure');

    await expect(api.getMe()).resolves.toMatchObject({ credits: 1120, frozenCredits: 0 });
    expect((await api.listGenerationTasks())[0]).toMatchObject({ status: 'failed', chargedCredits: 0 });
    expect((await api.listPointLedger())[0]).toMatchObject({ type: 'refund', delta: 8 });
  });

  it('charges only successful images after partial completion', async () => {
    const created = await generate({ ...baseInput, count: 2 });
    settleTask(created.id, 'partial');

    await expect(api.getMe()).resolves.toMatchObject({ credits: 1116, frozenCredits: 0 });
    expect((await api.listGenerationTasks())[0]).toMatchObject({ status: 'partial', chargedCredits: 4 });
    expect((await api.listGenerationTasks())[0].resultAssetIds).toHaveLength(1);
  });

  it('refunds and logs a cancellation exactly once', async () => {
    const created = await generate(baseInput);
    await api.cancelGenerationTask(created.id);
    await api.cancelGenerationTask(created.id);

    await expect(api.getMe()).resolves.toMatchObject({ credits: 1120, frozenCredits: 0 });
    expect((await api.listPointLedger()).filter((entry) => entry.description === '任务取消退回')).toHaveLength(1);
  });

  it('reconciles a persisted active task after its lifecycle deadline', async () => {
    const created = await generate(baseInput);
    mutateDb((draft) => {
      const task = draft.tasks.find((item) => item.id === created.id);
      if (task?.mockLifecycle) task.mockLifecycle.completionAt = new Date(Date.now() - 1000).toISOString();
    });

    expect((await api.listGenerationTasks()).find((item) => item.id === created.id)?.status).toBe('succeeded');
    await expect(api.getMe()).resolves.toMatchObject({ frozenCredits: 0 });
  });

  it('migrates a legacy active task by failing it and refunding frozen credits', async () => {
    // A task written by an older version carries no lifecycle, so it is seeded directly.
    mutateDb((draft) => {
      draft.tasks.unshift({
        id: 'task-legacy',
        input: { prompt: '旧任务', modelId: 'nano-banana-2', resolution: '1K', ratio: '1:1', count: 1, source: 'generation' },
        status: 'processing',
        progress: 52,
        estimatedCredits: 4,
        chargedCredits: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        resultAssetIds: [],
      });
      draft.user.credits -= 4;
      draft.user.frozenCredits += 4;
    });

    const migrated = (await api.listGenerationTasks()).find((item) => item.id === 'task-legacy');
    expect(migrated).toMatchObject({ status: 'failed', errorCode: 'INTERNAL_ERROR' });
    await expect(api.getMe()).resolves.toMatchObject({ credits: 1120, frozenCredits: 0 });
  });
});

describe('User supplied remix reference', () => {
  const input: WireInput = { ...baseInput, source: 'remix', prompt: '保留暖色光影，替换为我的咖啡礼盒', strength: 'balanced' };

  it('rejects missing and unknown references without freezing credits', async () => {
    await expect(api.submitGenerationTask('remix', 'quote-missing', input, 'remix-key-0001')).rejects.toMatchObject({ code: 'ASSET_INVALID' });
    await expect(api.submitGenerationTask('remix', 'quote-missing', { ...input, referenceAssetId: 'missing-image' }, 'remix-key-0002')).rejects.toMatchObject({ code: 'ASSET_INVALID' });
    await expect(api.getMe()).resolves.toMatchObject({ credits: 1120, frozenCredits: 0 });
    expect(loadDb().tasks).toHaveLength(0);
  });

  it('passes the uploaded reference first and the optional subject second without a template', async () => {
    const reference = saveReferenceUpload(new File(['reference'], 'reference.png', { type: 'image/png' }), 800, 600);
    const subject = saveReferenceUpload(new File(['subject'], 'subject.png', { type: 'image/png' }), 600, 600);
    const remixInput: WireInput = { ...input, referenceAssetId: reference.id, subjectAssetId: subject.id };
    const quote = await api.createGenerationQuote(remixInput);
    const task = await api.submitGenerationTask('remix', quote.id, remixInput, 'remix-key-0003');

    expect(task.input).toMatchObject({ referenceAssetId: reference.id, referenceAssetIds: [reference.id, subject.id], source: 'remix', prompt: input.prompt });
    expect(task.templateId).toBeUndefined();
    expect(task.remixStrength).toBe('balanced');
    settleTask(task.id, 'success');
    expect(loadDb().assets.find((asset) => asset.id === `asset-${task.id}-1`)).toMatchObject({ source: 'remix' });
  });

  it('falls back to the example itself when a remix submits no upload', async () => {
    const templateInput: WireInput = { ...input, referenceAssetId: undefined, templateId: 'template-1', templateVersion: 1 };
    const quote = await api.createGenerationQuote(templateInput);
    const task = await api.submitGenerationTask('remix', quote.id, templateInput, 'remix-key-0004');

    expect(task.input).toMatchObject({ referenceAssetIds: ['template:template-1'], source: 'remix' });
    expect(task).toMatchObject({ templateId: 'template-1', templateVersion: 1 });
  });
});

describe('Mock public catalog', () => {
  it('pages inspirations and toggles a like only for the method that was called', async () => {
    const page = await api.listInspirations();
    expect(page.nextCursor).toBeNull();
    expect(page.items).toHaveLength(12);

    const target = page.items[0];
    expect(target.liked).toBe(false);
    await expect(api.likeInspiration(target.id)).resolves.toMatchObject({ id: target.id, liked: true, likes: target.likes + 1 });
    // Liking twice must not count twice; only DELETE clears it.
    await expect(api.likeInspiration(target.id)).resolves.toMatchObject({ liked: true, likes: target.likes + 1 });
    await expect(api.unlikeInspiration(target.id)).resolves.toMatchObject({ liked: false, likes: target.likes });
  });

  it('filters inspirations by category and by text', async () => {
    const all = await api.listInspirations();
    const category = all.items[0].category;

    const filtered = await api.listInspirations({ category });
    expect(filtered.items.length).toBeGreaterThan(0);
    expect(filtered.items.every((item) => item.category === category)).toBe(true);
    expect((await api.listInspirations({ category: '全部' })).items).toHaveLength(0);
    await expect(api.listInspirations({ query: all.items[0].title })).resolves.toMatchObject({ items: [expect.objectContaining({ id: all.items[0].id })] });
    await expect(api.listInspirations({ query: '不会出现的画面' })).resolves.toMatchObject({ items: [] });
  });

  it('serves one template with its analysis and toggles its favorite', async () => {
    const page = await api.listTemplates({ platform: '小红书' });
    expect(page.nextCursor).toBeNull();
    expect(page.items.every((item) => item.platform === '小红书')).toBe(true);

    const id = page.items[0].id;
    const detail = await api.getTemplate(id);
    expect(detail).toMatchObject({ id, status: 'active' });
    expect(detail.analysis.composition).toBeTruthy();

    await expect(api.favoriteTemplate(id)).resolves.toMatchObject({ id, favorite: true });
    await expect(api.favoriteTemplate(id)).resolves.toMatchObject({ id, favorite: true });
    await expect(api.unfavoriteTemplate(id)).resolves.toMatchObject({ id, favorite: false });
    await expect(api.getTemplate('template-missing')).rejects.toMatchObject({ code: 'TEMPLATE_UNAVAILABLE', status: 404 });
  });
});

describe('Mock workflow and account boundaries', () => {
  const definition: WorkflowDefinition = {
    name: '批量主图',
    columns: [
      { id: 'reference', name: '商品素材', type: 'reference' },
      { id: 'style', name: '风格素材', type: 'reference' },
      { id: 'output', name: '主图', type: 'generation', prompt: '商业主图', sourceColumnIds: ['reference', 'style'], modelId: 'nano-banana-2', resolution: '1K', ratio: '1:1' },
    ],
    rows: [
      { rowKey: 'row-1', cells: { reference: 'asset-1', style: 'asset-2' } },
      { rowKey: 'row-2', cells: { reference: 'asset-3', style: 'asset-4' } },
    ],
  };

  it('prices a selection, then submits it into one child task per row and column', async () => {
    const saved = await api.createWorkflow(definition);
    const quote = await api.quoteWorkflowRun({ workflowId: saved.id, rowIds: ['row-1', 'row-2'] });

    expect(quote).toMatchObject({ submittable: true, totalCredits: 8, workflowVersion: 1 });
    expect(quote.items).toHaveLength(2);
    expect(quote.items[0]).toMatchObject({ rowKey: 'row-1', columnId: 'output', status: 'ready', unitCredits: 4 });

    const run = await api.submitWorkflowRun(quote.quoteId!, 'submit-key-0001');
    expect(run).toMatchObject({ totalCount: 2, estimatedCredits: 8, status: 'queued' });
    expect(run.childTaskIds).toHaveLength(2);
    await expect(api.getMe()).resolves.toMatchObject({ credits: 1112, frozenCredits: 8 });

    const children = (await api.listGenerationTasks()).filter((task) => run.childTaskIds.includes(task.id));
    expect(children).toHaveLength(2);
    expect(children[0]).toMatchObject({ workflowId: saved.id, batchId: run.id, workflowColumnId: 'output' });
    expect(children[0].input.referenceAssetIds).toHaveLength(2);

    settleTask(run.childTaskIds[0], 'success');
    settleTask(run.childTaskIds[1], 'failure');
    expect((await api.listWorkflowRuns())[0]).toMatchObject({ status: 'partial', succeededCount: 1, failedCount: 1, chargedCredits: 4 });
    expect((await api.listAssets()).some((asset) => asset.source === 'workflow')).toBe(true);
    const completed = await api.getWorkflow(saved.id);
    expect(completed.rows[0].cells.output).toMatch(/^asset-task-/);
    expect(completed.rows[1].cells.output).toBeUndefined();
    await expect(api.getMe()).resolves.toMatchObject({ credits: 1116, frozenCredits: 0 });
  });

  it('refuses a selection whose reference cells are empty', async () => {
    const saved = await api.createWorkflow({ ...definition, rows: [{ rowKey: 'row-1', cells: { reference: 'asset-1' } }] });
    const quote = await api.quoteWorkflowRun({ workflowId: saved.id, rowIds: ['row-1'] });

    expect(quote).toMatchObject({ quoteId: null, submittable: false, totalCredits: 0 });
    expect(quote.items[0]).toMatchObject({ status: 'invalid', error: { code: 'MISSING_REFERENCE' } });
    await expect(api.submitWorkflowRun('quote-missing', 'submit-key-0002')).rejects.toEqual(expect.objectContaining({ code: 'QUOTE_NOT_FOUND', status: 404 }));
  });

  it('replays a submission for the same idempotency key instead of charging twice', async () => {
    const saved = await api.createWorkflow(definition);
    const quote = await api.quoteWorkflowRun({ workflowId: saved.id, rowIds: ['row-1'] });
    const first = await api.submitWorkflowRun(quote.quoteId!, 'submit-key-0003');
    const replayed = await api.submitWorkflowRun(quote.quoteId!, 'submit-key-0003');

    expect(replayed.id).toBe(first.id);
    expect((await api.listWorkflowRuns())).toHaveLength(1);
  });

  it('rejects a stale quote once the workflow has been resaved', async () => {
    const saved = await api.createWorkflow(definition);
    const quote = await api.quoteWorkflowRun({ workflowId: saved.id, rowIds: ['row-1'] });
    await api.updateWorkflow(saved.id, { ...definition, name: '批量主图 v2', version: saved.version });

    await expect(api.submitWorkflowRun(quote.quoteId!, 'submit-key-0004')).rejects.toEqual(expect.objectContaining({ code: 'WORKFLOW_VERSION_CONFLICT', status: 409 }));
  });

  it('quotes only the failed items of a settled run, and refuses while it is still running', async () => {
    const saved = await api.createWorkflow(definition);
    const quote = await api.quoteWorkflowRun({ workflowId: saved.id, rowIds: ['row-1', 'row-2'] });
    const run = await api.submitWorkflowRun(quote.quoteId!, 'submit-key-0005');

    await expect(api.quoteWorkflowRun({ retryRunId: run.id })).rejects.toEqual(expect.objectContaining({ code: 'RUN_NOT_SETTLED', status: 409 }));

    settleTask(run.childTaskIds[0], 'success');
    settleTask(run.childTaskIds[1], 'failure');
    const retryQuote = await api.quoteWorkflowRun({ retryRunId: run.id });
    expect(retryQuote).toMatchObject({ submittable: true, totalCredits: 4 });
    expect(retryQuote.items).toHaveLength(1);
    expect(retryQuote.items[0]).toMatchObject({ rowKey: 'row-2', columnId: 'output' });

    const retried = await api.retryWorkflowRun(run.id, retryQuote.quoteId!, 'retry-key-0001');
    expect(retried).toMatchObject({ totalCount: 1, retryOfRunId: run.id });
    settleTask(retried.childTaskIds[0], 'success');
    expect((await api.listWorkflowRuns()).find((item) => item.id === run.id)?.retryRunIds).toEqual([retried.id]);
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
    await expect(api.register({ username: 'invite_user', email: 'invited@example.com', password: 'registration-12', code: '123456', inviteCode: 'VIVI-MIA88' })).resolves.toMatchObject({ credits: 105 });
    expect(loadDb().ledger).toContainEqual(expect.objectContaining({ type: 'invite', delta: 100 }));
    expect(loadDb().notifications).toContainEqual(expect.objectContaining({ type: 'credits', title: '邀请奖励到账', content: '100 积分已到账。', href: '/account', read: false }));

    resetDb();
    await api.sendCode('unknown@example.com', 'register');
    const beforeUnknownInvite = structuredClone(loadDb());
    const credentialBeforeUnknownInvite = getCredentialHash();
    await expect(api.register({ username: 'unknown_user', email: 'unknown@example.com', password: 'registration-12', code: '123456', inviteCode: 'UNKNOWN-CODE' })).rejects.toEqual(expect.objectContaining({ code: 'INVALID_INVITE_CODE', status: 422 }));
    expect(loadDb()).toEqual(beforeUnknownInvite);
    expect(getCredentialHash()).toBe(credentialBeforeUnknownInvite);
  });

  it('keeps a registration code usable when an invalid invite is rejected', async () => {
    await api.sendCode('atomic@example.com', 'register');
    const beforeInvalidInvite = structuredClone(loadDb());
    await expect(api.register({ username: 'atomic_user', email: 'atomic@example.com', password: 'registration-12', code: '123456', inviteCode: 'INVALID-CODE' })).rejects.toEqual(expect.objectContaining({ code: 'INVALID_INVITE_CODE', status: 422 }));
    expect(loadDb()).toEqual(beforeInvalidInvite);
    await expect(api.register({ username: 'atomic_user', email: 'atomic@example.com', password: 'registration-12', code: '123456', inviteCode: 'VIVI-MIA88' })).resolves.toMatchObject({ credits: 105 });
  });

  it('rejects an existing account before consuming a challenge or changing any registration state', async () => {
    mutateDb((draft) => { draft.user.username = 'seed_user'; });
    await api.sendCode('demo@viviai.local', 'register');
    const before = structuredClone(loadDb());
    const credentialBefore = getCredentialHash();

    await expect(api.register({ username: 'seed_user', email: 'demo@viviai.local', password: 'registration-12', code: '123456', inviteCode: 'VIVI-MIA88' })).rejects.toEqual(expect.objectContaining({ code: 'ACCOUNT_EXISTS', status: 409 }));

    expect(loadDb()).toEqual(before);
    expect(getCredentialHash()).toBe(credentialBefore);
    expect(loadDb().challenges.find((item) => item.email === 'demo@viviai.local' && item.purpose === 'register')).toMatchObject({ used: false });
  });

  it('validates registration schema and duplicate usernames before consuming the registration code', async () => {
    mutateDb((draft) => { draft.user.username = 'seed_user'; });
    await api.sendCode('new@example.com', 'register');
    const beforeDuplicate = structuredClone(loadDb());
    await expect(api.register({ username: 'seed_user', email: 'new@example.com', password: 'registration-12', code: '123456' })).rejects.toEqual(expect.objectContaining({ code: 'ACCOUNT_EXISTS', status: 409 }));
    expect(loadDb()).toEqual(beforeDuplicate);

    await api.sendCode('schema@example.com', 'register');
    const beforeSchema = structuredClone(loadDb());
    await expect(api.register({ username: 'Invalid Name', email: 'schema@example.com', password: 'registration-12', code: '123456' })).rejects.toEqual(expect.objectContaining({ code: 'INVALID_INPUT', status: 400 }));
    expect(loadDb()).toEqual(beforeSchema);
    await expect(api.register({ username: 'valid_user', email: 'schema@example.com', password: 'registration-12', code: '123456' })).resolves.toMatchObject({ username: 'valid_user' });
  });

  it('matches backend Zod email validation without consuming a corrected registration challenge', async () => {
    await api.sendCode('valid.user@example.co', 'register');
    const before = structuredClone(loadDb());
    const credentialBefore = getCredentialHash();
    const invalidEmails = [
      'valid.user@example..co',
      'valid.user@example.c',
      `${'a'.repeat(244)}@example.co`,
    ];

    for (const email of invalidEmails) {
      await expect(api.register({ username: 'email_user', email, password: 'registration-12', code: '123456' })).rejects.toEqual(expect.objectContaining({ code: 'INVALID_INPUT', status: 400 }));
      expect(loadDb()).toEqual(before);
      expect(getCredentialHash()).toBe(credentialBefore);
    }

    await expect(api.register({ username: 'email_user', email: '  Valid.User@EXAMPLE.CO  ', password: 'registration-12', code: '123456' })).resolves.toMatchObject({ username: 'email_user', email: 'valid.user@example.co' });
  });

  it('isolates verification code purposes and consumes each code once', async () => {
    await api.sendCode('next@example.com', 'change-email');
    await expect(api.changePassword({ code: '123456', password: 'password-long-12' })).rejects.toEqual(expect.objectContaining({ code: 'INVALID_CODE', status: 400 }));
    await expect(api.changeEmail({ email: 'next@example.com', code: '123456' })).resolves.toMatchObject({ email: 'next@example.com' });
    await expect(api.changeEmail({ email: 'again@example.com', code: '123456' })).rejects.toEqual(expect.objectContaining({ code: 'INVALID_CODE', status: 400 }));
  });

  it('enforces backend idempotency key bounds and replays its notification exactly once', async () => {
    await expect(api.redeemCode('VIVIAI2026', '123456789012345')).rejects.toEqual(expect.objectContaining({ code: 'INVALID_INPUT', status: 400 }));
    const key = '0123456789abcde_';
    await expect(api.redeemCode('VIVIAI2026', key)).resolves.toMatchObject({ credits: 1220 });
    const afterFirst = await api.listNotifications();
    expect(afterFirst.filter((item) => item.title === '兑换积分到账')).toEqual([expect.objectContaining({ type: 'credits', content: '100 积分已到账。', href: '/account', read: false })]);
    await expect(api.redeemCode('VIVIAI2026', key)).resolves.toMatchObject({ credits: 1220 });
    expect((await api.listNotifications()).filter((item) => item.title === '兑换积分到账')).toHaveLength(1);
    await expect(api.redeemCode('VIVIAI2026', 'a'.repeat(101))).rejects.toEqual(expect.objectContaining({ code: 'INVALID_INPUT', status: 400 }));
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
    await api.register({ username: 'new_user', email: 'new@example.com', password: 'initial-password-88', code: '123456' });
    const registered = loadDb();
    expect(registered.user).toMatchObject({ username: 'new_user', email: 'new@example.com', planId: 'free', credits: 5 });
    expect(registered.user.id).not.toBe(priorUserId);
    expect(registered.user.avatarUrl).toBeUndefined();
    expect(registered.user.inviteCode).not.toBe('OLD-CODE');
    expect(registered.inspirations.every((item) => !item.liked)).toBe(true);
    expect(registered.templates.every((item) => !item.favorite)).toBe(true);
    expect(JSON.parse(window.localStorage.getItem('viviai-mock-db-v1') ?? '{}')).not.toHaveProperty('credentialHash');
    await api.logout();
    await expect(api.login({ account: 'new@example.com', password: 'initial-password-88' })).resolves.toMatchObject({ username: 'new_user' });

    await api.sendCode('changed@example.com', 'change-email');
    await api.changeEmail({ email: 'changed@example.com', code: '123456' });
    await api.sendCode('changed@example.com', 'change-password');
    await api.changePassword({ code: '123456', password: 'changed-password-88' });
    await api.logout();
    await expect(api.login({ account: 'new@example.com', password: 'initial-password-88' })).rejects.toEqual(expect.objectContaining({ code: 'INVALID_CREDENTIALS' }));
    await expect(api.login({ account: 'changed@example.com', password: 'changed-password-88' })).resolves.toMatchObject({ email: 'changed@example.com' });
  });
});
