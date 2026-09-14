import { delay, http, HttpResponse } from 'msw';
import { z } from 'zod';

import { estimateCredits } from '@/src/lib/pricing';
import type {
  ApiErrorCode,
  GenerationInput,
  GenerationQuote,
  GenerationTask,
  ImageAsset,
  Order,
  TaskStatus,
  ToolQuoteInput,
  User,
  Workflow,
  WorkflowDefinition,
  WorkflowGenerationColumn,
  WorkflowQuoteItem,
  WorkflowQuoteRequest,
  WorkflowRow,
  WorkflowRun,
  WorkflowRunQuote,
} from '@/src/types/domain';
import type { MockGenerationQuote, MockToolQuote, MockWorkflowRunQuote } from './fixtures';
import { getCredentialHash, loadDb, mutateDb, resetDb, saveDb, setCredentialHash, settleTask } from './db';
import { hasReferenceUpload, saveReferenceUpload } from './referenceUploads';

const api = '*/api';
const registrationEmail = z.string().trim().toLowerCase().email().max(254);

function requestId(): string {
  return crypto.randomUUID();
}

function ok<T>(data: T, message = 'ok') {
  return HttpResponse.json({ data, message, requestId: requestId() });
}

function fail(status: number, code: ApiErrorCode, message: string) {
  return HttpResponse.json({ data: null, code, message, requestId: requestId() }, { status });
}

function sessionUser(): User | null {
  const db = loadDb();
  return db.sessionUserId ? db.user : null;
}

function authError() {
  return sessionUser() ? null : fail(401, 'AUTH_REQUIRED', '请先登录后再访问。');
}

type ChallengePurpose = 'register' | 'reset-password' | 'change-email' | 'change-password';

function consumeChallenge(email: string, purpose: ChallengePurpose, code: string): boolean {
  let consumed = false;
  mutateDb((draft) => {
    const challenge = draft.challenges.find((item) => item.email === email.trim().toLocaleLowerCase() && item.purpose === purpose && item.code === code && !item.used);
    if (challenge) {
      challenge.used = true;
      consumed = true;
    }
  });
  return consumed;
}

async function credentialHash(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

class MockFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function activeTaskCount(): number {
  return loadDb().tasks.filter((task) => task.status === 'queued' || task.status === 'processing').length;
}

function scheduleTask(taskId: string): void {
  window.setTimeout(() => {
    mutateDb((db) => {
      const task = db.tasks.find((item) => item.id === taskId);
      if (task?.status === 'queued') {
        task.status = 'processing';
        task.progress = 52;
        task.updatedAt = new Date().toISOString();
      }
    });
  }, 220);
  window.setTimeout(() => settleTask(taskId, 'success'), 950);
}

/** The generation request exactly as the console submits it to the backend. */
interface WireGenerationInput {
  source?: 'create' | 'remix';
  modelId: string;
  prompt: string;
  resolution: string;
  ratio: string;
  count: number;
  referenceAssetId?: string;
  subjectAssetId?: string;
  strength?: GenerationInput['strength'];
}

/**
 * Reads a submitted request into the input the app gets back on the task, mirroring the frontend
 * normalizer: `create` becomes the domain's `generation`, the fixed `standard` quality and the
 * `format` pin are dropped, and the two remix image roles collapse into the ordered reference list.
 */
function submittedInput(wire: WireGenerationInput): GenerationInput {
  const references = [wire.referenceAssetId, wire.subjectAssetId].filter((id): id is string => Boolean(id));
  return {
    prompt: wire.prompt,
    modelId: wire.modelId,
    resolution: wire.resolution as GenerationInput['resolution'],
    ratio: wire.ratio as GenerationInput['ratio'],
    count: wire.count as GenerationInput['count'],
    source: wire.source === 'remix' ? 'remix' : 'generation',
    ...(references.length ? { referenceAssetId: references[0], referenceAssetIds: references } : {}),
    ...(wire.strength ? { strength: wire.strength } : {}),
  };
}

/**
 * Prices one generation request. The wire format pins `quality` to the `standard` tier, which the
 * pricing table does not model, so it stays out — the same way workflow batches price.
 */
function priceGeneration(input: Pick<GenerationInput, 'modelId' | 'resolution' | 'count'>): number {
  return estimateCredits({ modelId: input.modelId, resolution: input.resolution, count: input.count });
}

/** The quote as the API presents it, without the bookkeeping the double stores beside it. */
function presentGenerationQuote(quote: MockGenerationQuote): GenerationQuote {
  return {
    id: quote.id,
    input: quote.input,
    inputHash: quote.inputHash,
    unitCredits: quote.unitCredits,
    totalCredits: quote.totalCredits,
    priceVersion: quote.priceVersion,
    createdAt: quote.createdAt,
    expiresAt: quote.expiresAt,
  };
}

/**
 * Prices a generation request without charging, mirroring `POST /generation-quotes`. The stored
 * quote carries the input it was priced against so submission charges exactly what was quoted.
 */
function createGenerationQuote(input: GenerationInput): MockGenerationQuote {
  const user = sessionUser();
  if (!user) throw new MockFailure(401, 'AUTH_REQUIRED', '请先登录后再生成。');
  if (!input.prompt?.trim()) throw new MockFailure(400, 'INVALID_INPUT', '请输入画面描述。');
  const model = loadDb().models.find((item) => item.id === input.modelId);
  if (!model || model.status !== 'available') throw new MockFailure(409, 'MODEL_UNAVAILABLE', '当前模型不可用，请选择其他模型。');
  let totalCredits: number;
  try {
    totalCredits = priceGeneration(input);
  } catch {
    throw new MockFailure(400, 'PARAMETER_UNSUPPORTED', '当前模型不支持这组生成参数。');
  }
  const createdAt = new Date();
  const quote: MockGenerationQuote = {
    id: crypto.randomUUID(),
    input,
    inputHash: crypto.randomUUID(),
    unitCredits: totalCredits / Math.max(1, input.count),
    totalCredits,
    priceVersion: null,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + 300_000).toISOString(),
    consumed: false,
  };
  mutateDb((draft) => {
    draft.generationQuotes.unshift(quote);
  });
  return quote;
}

/**
 * Consumes a quote and queues the task, mirroring `POST /generation-tasks` and `/remix-tasks`:
 * the idempotency key is replayed before the quote is spent, so a retried request cannot
 * double-charge.
 */
function submitGenerationTask(
  quoteId: string,
  input: GenerationInput,
  idempotencyKey: string | null,
  context?: Pick<
    GenerationTask,
    | 'templateId'
    | 'templateVersion'
    | 'remixStrength'
    | 'toolId'
    | 'workflowId'
    | 'batchId'
    | 'workflowRowId'
    | 'workflowColumnId'
  >,
): GenerationTask {
  if (!idempotencyKey || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey))
    throw new MockFailure(400, 'INVALID_INPUT', '缺少有效的幂等键。');
  const db = loadDb();
  const replayed = db.generationTaskKeys.find((item) => item.id === idempotencyKey);
  if (replayed) {
    const task = db.tasks.find((item) => item.id === replayed.taskId);
    if (task) return task;
  }
  const quote = db.generationQuotes.find((item) => item.id === quoteId);
  if (!quote) throw new MockFailure(404, 'QUOTE_NOT_FOUND', '报价不存在，请重新报价。');
  if (quote.consumed) throw new MockFailure(409, 'QUOTE_USED', '该报价已被使用，请重新报价。');
  if (Date.parse(quote.expiresAt) <= Date.now()) throw new MockFailure(409, 'QUOTE_EXPIRED', '报价已过期，请重新报价。');
  const user = sessionUser();
  if (!user) throw new MockFailure(401, 'AUTH_REQUIRED', '请先登录后再生成。');
  if (user.credits < quote.totalCredits) throw new MockFailure(402, 'INSUFFICIENT_CREDITS', '积分不足，请升级套餐。');

  const task = createTask(input, context, quote.totalCredits);
  mutateDb((draft) => {
    const stored = draft.generationQuotes.find((item) => item.id === quoteId);
    if (stored) stored.consumed = true;
    draft.generationTaskKeys.push({ id: idempotencyKey, taskId: task.id });
  });
  return task;
}

/**
 * Queues one task and freezes its credits. `quotedCredits` is the amount a quote charged for this
 * request; a caller coming from a quote passes it so a request that drifted from what was priced
 * is refused, while the workflow and tool paths — which price their own children — leave it out.
 */
function createTask(
  input: GenerationInput,
  context?: Pick<GenerationTask, 'templateId' | 'templateVersion' | 'remixStrength' | 'toolId' | 'workflowId' | 'batchId' | 'workflowRowId' | 'workflowColumnId'>,
  quotedCredits?: number,
): GenerationTask {
  const user = sessionUser();
  if (!user) throw new MockFailure(401, 'AUTH_REQUIRED', '请先登录后再生成。');
  if (!input.prompt.trim()) throw new MockFailure(400, 'INVALID_INPUT', '请输入画面描述。');

  const db = loadDb();
  const model = db.models.find((item) => item.id === input.modelId);
  if (!model || model.status !== 'available') throw new MockFailure(409, 'MODEL_UNAVAILABLE', '当前模型不可用，请选择其他模型。');
  if (activeTaskCount() >= user.concurrency) throw new MockFailure(409, 'CONCURRENCY_LIMIT', '进行中的任务已达到套餐上限。');

  let estimatedCredits: number;
  try {
    estimatedCredits = priceGeneration(input);
  } catch {
    throw new MockFailure(400, 'PARAMETER_UNSUPPORTED', '当前模型不支持这组生成参数。');
  }
  if (quotedCredits !== undefined && quotedCredits !== estimatedCredits)
    throw new MockFailure(409, 'QUOTE_MISMATCH', '报价与当前参数不一致，请重新报价。');
  if (user.credits < estimatedCredits) throw new MockFailure(402, 'INSUFFICIENT_CREDITS', '积分不足，请升级套餐。');

  const createdAtMs = Date.now();
  const createdAt = new Date(createdAtMs).toISOString();
  const task: GenerationTask = {
    id: `task-${crypto.randomUUID()}`,
    input,
    status: 'queued',
    progress: 8,
    estimatedCredits,
    chargedCredits: 0,
    createdAt,
    updatedAt: createdAt,
    resultAssetIds: [],
    mockLifecycle: {
      processingAt: new Date(createdAtMs + 220).toISOString(),
      completionAt: new Date(createdAtMs + 950).toISOString(),
      outcome: 'success',
    },
    ...context,
  };

  mutateDb((draft) => {
    draft.user.credits -= estimatedCredits;
    draft.user.frozenCredits += estimatedCredits;
    draft.tasks.unshift(task);
    draft.ledger.unshift({
      id: `ledger-${crypto.randomUUID()}`,
      type: 'freeze',
      description: input.source === 'remix' ? '爆款复刻冻结' : input.source === 'tool' ? '工具任务冻结' : input.source === 'workflow' ? '工作流任务冻结' : '图片生成冻结',
      delta: -estimatedCredits,
      balance: draft.user.credits,
      createdAt,
    });
  });
  scheduleTask(task.id);
  return task;
}

function textMatch(value: string, query: string): boolean {
  return value.toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

const workflowKey = /^[a-z][a-z0-9_-]{1,63}$/;
const terminalRunStatuses: TaskStatus[] = ['succeeded', 'partial', 'failed', 'cancelled'];

function isTerminalRun(status: TaskStatus): boolean {
  return terminalRunStatuses.includes(status);
}

/** Mirrors the server's version-1 graph rules: unique keys, and output columns fed by reference columns. */
function workflowDefinitionError(definition: WorkflowDefinition): string | null {
  if (!definition.name?.trim()) return '请填写工作流名称。';
  if (!definition.columns?.length) return '工作流至少需要一列。';
  const ids = new Set<string>();
  for (const column of definition.columns) {
    if (!workflowKey.test(column.id)) return '列标识需以小写字母开头，仅含小写字母、数字、下划线和连字符。';
    if (ids.has(column.id)) return `列标识「${column.id}」重复。`;
    ids.add(column.id);
  }
  if (!definition.columns.some((column) => column.type === 'reference')) return '工作流至少需要一个参考列。';
  for (const column of definition.columns) {
    if (column.type === 'reference') continue;
    if (!column.sourceColumnIds.length) return `「${column.name}」还没有引用参考列。`;
    for (const sourceId of column.sourceColumnIds) {
      if (definition.columns.find((candidate) => candidate.id === sourceId)?.type !== 'reference') return '生成列只能引用参考列。';
    }
  }
  for (const row of definition.rows ?? []) {
    for (const cellKey of Object.keys(row.cells ?? {})) {
      if (!ids.has(cellKey)) return `单元格引用了不存在的列「${cellKey}」。`;
    }
  }
  return null;
}

function generationInputFor(row: WorkflowRow, column: WorkflowGenerationColumn): GenerationInput {
  const referenceAssetIds = column.sourceColumnIds.map((id) => row.cells[id]).filter((id): id is string => Boolean(id));
  return {
    prompt: column.prompt.trim() || column.name,
    modelId: column.modelId,
    resolution: column.resolution,
    ratio: column.ratio,
    count: 1,
    referenceAssetIds,
    ...(referenceAssetIds[0] ? { referenceAssetId: referenceAssetIds[0] } : {}),
    source: 'workflow',
  };
}

/** Prices the requested row/column pairs, or reports every pair that cannot run. */
function priceWorkflowRun(
  workflow: Workflow,
  targets: Array<{ rowKey: string; columnKey: string }>,
  retryOfRunId: string | null,
): MockWorkflowRunQuote {
  const db = loadDb();
  const rejected: WorkflowQuoteItem[] = [];
  const priced: WorkflowQuoteItem[] = [];
  let totalCredits = 0;
  let expiresAtMs = 0;
  for (const target of targets) {
    const row = workflow.rows.find((candidate) => candidate.rowKey === target.rowKey);
    const column = workflow.columns.find((candidate) => candidate.id === target.columnKey);
    const reject = (code: string, message: string) =>
      rejected.push({ rowKey: target.rowKey, columnId: target.columnKey, columnName: column?.name ?? null, status: 'invalid', error: { code, message } });
    if (!row || column?.type !== 'generation') {
      reject('INVALID_WORKFLOW_SELECTION', '这一行或列已不存在，请重新选择。');
      continue;
    }
    const referenceAssetIds = column.sourceColumnIds.map((id) => row.cells[id]).filter(Boolean);
    if (column.sourceColumnIds.length !== referenceAssetIds.length) {
      reject('MISSING_REFERENCE', '该单元格还没有选择参考图。');
      continue;
    }
    if (referenceAssetIds.some((id) => !db.assets.some((asset) => asset.id === id))) {
      reject('INVALID_ASSET', '参考素材已失效，请重新选择。');
      continue;
    }
    if (!db.models.some((model) => model.id === column.modelId && model.status === 'available')) {
      reject('MODEL_UNAVAILABLE', '当前模型不可用，请更换模型。');
      continue;
    }
    let unitCredits: number;
    try {
      unitCredits = estimateCredits({ modelId: column.modelId, resolution: column.resolution, count: 1 });
    } catch {
      reject('INVALID_GENERATION_INPUT', '当前模型不支持这组生成参数。');
      continue;
    }
    const expiresAt = Date.now() + 10 * 60 * 1000;
    expiresAtMs = expiresAtMs === 0 ? expiresAt : Math.min(expiresAtMs, expiresAt);
    totalCredits += unitCredits;
    priced.push({
      rowKey: row.rowKey,
      columnId: column.id,
      columnName: column.name,
      status: 'ready',
      quoteId: `quote-${crypto.randomUUID()}`,
      modelId: column.modelId,
      resolution: column.resolution,
      ratio: column.ratio,
      count: 1,
      unitCredits,
      totalCredits: unitCredits,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
    });
  }

  const submittable = rejected.length === 0 && priced.length > 0;
  const quote: MockWorkflowRunQuote = {
    quoteId: submittable ? `quote-${crypto.randomUUID()}` : null,
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    submittable,
    totalCredits: submittable ? totalCredits : 0,
    createdAt: submittable ? new Date().toISOString() : null,
    expiresAt: submittable ? new Date(expiresAtMs).toISOString() : null,
    items: submittable ? priced : rejected,
    workflowName: workflow.name,
    snapshot: { name: workflow.name, columns: workflow.columns, rows: workflow.rows },
    retryOfRunId,
    targets: submittable ? targets : [],
    consumed: false,
  };
  if (submittable) {
    mutateDb((draft) => {
      draft.workflowRunQuotes.unshift(quote);
    });
  }
  return quote;
}

/** Consumes a batch quote and creates one generation task — and one run item — per quoted pair. */
function submitWorkflowRun(quoteId: string, idempotencyKey: string | null, retryOfRunId: string | null): WorkflowRun {
  if (!idempotencyKey || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) throw new MockFailure(400, 'INVALID_INPUT', '缺少有效的幂等键。');
  const db = loadDb();
  const quote = db.workflowRunQuotes.find((item) => item.quoteId === quoteId);
  if (!quote) throw new MockFailure(404, 'QUOTE_NOT_FOUND', '报价不存在，请重新报价。');
  const replayed = db.workflowRunKeys.find((item) => item.id === idempotencyKey);
  if (replayed) {
    const run = db.workflowRuns.find((item) => item.id === replayed.runId);
    if (run) return run;
  }
  if (quote.consumed) throw new MockFailure(409, 'QUOTE_USED', '该报价已被使用，请重新报价。');
  if (quote.expiresAt && Date.parse(quote.expiresAt) <= Date.now()) throw new MockFailure(409, 'QUOTE_EXPIRED', '报价已过期，请重新报价。');
  if (!quote.submittable || !quote.quoteId) throw new MockFailure(400, 'INVALID_INPUT', '该报价包含无法运行的行，请修正后重新报价。');
  if (quote.retryOfRunId !== retryOfRunId) throw new MockFailure(409, 'ORIGIN_MISMATCH', '报价与这个批次不匹配，请重新报价。');
  const workflow = db.workflows.find((item) => item.id === quote.workflowId);
  if (!workflow) throw new MockFailure(404, 'WORKFLOW_NOT_FOUND', '工作流不存在。');
  if (!quote.retryOfRunId && workflow.version !== quote.workflowVersion) throw new MockFailure(409, 'WORKFLOW_VERSION_CONFLICT', '工作流已被其他改动更新，请重新报价。');
  if (db.user.credits < quote.totalCredits) throw new MockFailure(402, 'INSUFFICIENT_CREDITS', '积分不足，无法运行所选任务。');
  if (activeTaskCount() + quote.targets.length > db.user.concurrency) throw new MockFailure(409, 'CONCURRENCY_LIMIT', '批量任务超过当前套餐并发上限。');

  const jobs = quote.targets.map((target) => {
    const row = quote.snapshot.rows.find((candidate) => candidate.rowKey === target.rowKey);
    const column = quote.snapshot.columns.find((candidate) => candidate.id === target.columnKey);
    if (!row || column?.type !== 'generation') throw new MockFailure(400, 'INVALID_WORKFLOW_SELECTION', '报价已失效，请重新报价。');
    return { target, column, input: generationInputFor(row, column) };
  });

  const runId = `run-${crypto.randomUUID()}`;
  const rollback = structuredClone(db);
  let children: GenerationTask[];
  try {
    children = jobs.map((job) => createTask(job.input, { workflowId: quote.workflowId, batchId: runId, workflowRowId: job.target.rowKey, workflowColumnId: job.target.columnKey }));
  } catch (error) {
    saveDb(rollback);
    if (error instanceof MockFailure) throw error;
    throw new MockFailure(500, 'INTERNAL_ERROR', '批量任务创建失败，积分未扣除。');
  }

  const createdAt = new Date().toISOString();
  const run: WorkflowRun = {
    id: runId,
    workflowId: quote.workflowId,
    workflowName: quote.workflowName,
    workflowVersion: quote.workflowVersion,
    status: 'queued',
    totalCount: children.length,
    succeededCount: 0,
    failedCount: 0,
    cancelledCount: 0,
    cancelRequested: false,
    retryOfRunId: quote.retryOfRunId,
    retryRunIds: [],
    estimatedCredits: quote.totalCredits,
    chargedCredits: 0,
    createdAt,
    updatedAt: createdAt,
    childTaskIds: children.map((task) => task.id),
    items: children.map((task, index) => ({
      id: `run-item-${crypto.randomUUID()}`,
      rowKey: jobs[index]!.target.rowKey,
      columnKey: jobs[index]!.target.columnKey,
      columnName: jobs[index]!.column.name,
      status: 'queued' as TaskStatus,
      errorCode: null,
      retryable: true,
      generationJobId: task.id,
      resultAssetIds: [],
    })),
  };
  mutateDb((draft) => {
    draft.workflowRuns.unshift(run);
    draft.workflowRunKeys.push({ id: idempotencyKey, runId });
    const stored = draft.workflowRunQuotes.find((item) => item.quoteId === quoteId);
    if (stored) stored.consumed = true;
    const origin = quote.retryOfRunId ? draft.workflowRuns.find((item) => item.id === quote.retryOfRunId) : undefined;
    if (origin) origin.retryRunIds.push(runId);
  });
  return run;
}

function runQuoteDto(quote: MockWorkflowRunQuote): WorkflowRunQuote {
  return {
    quoteId: quote.quoteId,
    workflowId: quote.workflowId,
    workflowVersion: quote.workflowVersion,
    submittable: quote.submittable,
    totalCredits: quote.totalCredits,
    createdAt: quote.createdAt,
    expiresAt: quote.expiresAt,
    items: quote.items,
  };
}

export const handlers = [
  http.get(`${api}/me`, () => ok(sessionUser())),

  http.post(`${api}/auth/login`, async ({ request }) => {
    const input = (await request.json()) as { account: string; password: string };
    const current = loadDb();
    const account = input.account.trim().toLocaleLowerCase();
    const accountValid = account === current.user.email.toLocaleLowerCase() || account === current.user.username.toLocaleLowerCase();
    if (!accountValid || await credentialHash(input.password) !== getCredentialHash()) return fail(401, 'INVALID_CREDENTIALS', '账号或密码不正确。');
    const db = mutateDb((draft) => {
      draft.sessionUserId = draft.user.id;
    });
    return ok(db.user, '登录成功');
  }),

  http.post(`${api}/auth/logout`, () => {
    mutateDb((draft) => {
      draft.sessionUserId = null;
    });
    return ok(null, '已退出登录');
  }),

  http.post(`${api}/auth/register`, async ({ request }) => {
    const input = (await request.json()) as Partial<{ username: string; email: string; password: string; code: string; inviteCode: string }>;
    const username = typeof input.username === 'string' ? input.username.trim().toLocaleLowerCase() : '';
    const parsedEmail = registrationEmail.safeParse(input.email);
    const email = parsedEmail.success ? parsedEmail.data : '';
    const password = typeof input.password === 'string' ? input.password : '';
    const code = typeof input.code === 'string' ? input.code : '';
    const inviter = input.inviteCode === undefined ? undefined : typeof input.inviteCode === 'string' ? input.inviteCode.trim().toUpperCase() : '';
    if (!/^[a-z0-9_]{3,32}$/.test(username) || !parsedEmail.success || password.length < 12 || password.length > 128 || !/^\d{6}$/.test(code) || (inviter !== undefined && !/^[A-Z0-9-]{4,64}$/.test(inviter))) {
      return fail(400, 'INVALID_INPUT', '请完整填写有效的注册信息。');
    }
    const current = loadDb();
    if (current.user.email.trim().toLocaleLowerCase() === email || current.user.username.trim().toLocaleLowerCase() === username) {
      return fail(409, 'ACCOUNT_EXISTS', 'Email or username is already registered');
    }
    const challenge = current.challenges.find((item) => item.email === email && item.purpose === 'register' && item.code === code && !item.used);
    if (!challenge) return fail(400, 'INVALID_CODE', 'Verification code is invalid or expired');
    if (inviter && inviter !== current.user.inviteCode) return fail(422, 'INVALID_INVITE_CODE', '邀请码无效。');
    const passwordHash = await credentialHash(password);
    const userId = `user-${crypto.randomUUID()}`;
    const inviteCode = `VIVI-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
    let registered = false;
    let accountExists = false;
    let invalidInvite = false;
    const db = mutateDb((draft) => {
      if (draft.user.email.trim().toLocaleLowerCase() === email || draft.user.username.trim().toLocaleLowerCase() === username) {
        accountExists = true;
        return;
      }
      const activeChallenge = draft.challenges.find((item) => item.email === email && item.purpose === 'register' && item.code === code && !item.used);
      if (!activeChallenge) return;
      if (inviter && inviter !== draft.user.inviteCode) {
        invalidInvite = true;
        return;
      }
      activeChallenge.used = true;
      draft.user.id = userId;
      draft.user.username = username;
      draft.user.email = email;
      delete draft.user.avatarUrl;
      draft.user.planId = 'free';
      draft.user.planName = '免费套餐';
      draft.user.credits = inviter ? 105 : 5;
      draft.user.frozenCredits = 0;
      draft.user.concurrency = 2;
      draft.user.inviteCode = inviteCode;
      draft.sessionUserId = userId;
      draft.tasks = [];
      draft.assets = [];
      draft.deletedAssets = [];
      draft.workflows = [];
      draft.workflowRuns = [];
      draft.workflowRunQuotes = [];
      draft.workflowRunKeys = [];
      draft.orders = [];
      draft.invites = [];
      draft.redeemedCodes = [];
      draft.redemptionAttempts = [];
      for (const inspiration of draft.inspirations) {
        if (inspiration.liked) inspiration.likes = Math.max(0, inspiration.likes - 1);
        inspiration.liked = false;
      }
      for (const template of draft.templates) template.favorite = false;
      draft.notifications = [{ id: `notice-${crypto.randomUUID()}`, type: 'system', title: '欢迎来到 VIVIAI', content: inviter ? '注册与邀请奖励已到账，开始你的第一张作品吧。' : '注册奖励已到账，开始你的第一张作品吧。', read: false, createdAt: new Date().toISOString() }];
      draft.ledger = [{
        id: `ledger-${crypto.randomUUID()}`,
        type: 'register',
        description: '注册奖励',
        delta: 5,
        balance: 5,
        createdAt: new Date().toISOString(),
      }];
      if (inviter) {
        draft.ledger.unshift({ id: `ledger-${crypto.randomUUID()}`, type: 'invite', description: '邀请码奖励', delta: 100, balance: 105, createdAt: new Date().toISOString() });
        draft.notifications.unshift({ id: `notice-${crypto.randomUUID()}`, type: 'credits', title: '邀请奖励到账', content: '100 积分已到账。', href: '/account', read: false, createdAt: new Date().toISOString() });
      }
      registered = true;
    });
    if (accountExists) return fail(409, 'ACCOUNT_EXISTS', 'Email or username is already registered');
    if (invalidInvite) return fail(422, 'INVALID_INVITE_CODE', '邀请码无效。');
    if (!registered) return fail(400, 'INVALID_CODE', 'Verification code is invalid or expired');
    setCredentialHash(passwordHash);
    return ok(db.user, '注册成功');
  }),

  http.post(`${api}/auth/send-code`, async ({ request }) => {
    const { email, purpose = 'register' } = (await request.json()) as { email: string; purpose?: ChallengePurpose };
    if (!email.includes('@') || !['register', 'reset-password', 'change-email', 'change-password'].includes(purpose)) return fail(400, 'INVALID_INPUT', '请输入有效邮箱和验证码用途。');
    mutateDb((draft) => {
      const normalizedEmail = email.trim().toLocaleLowerCase();
      draft.challenges = draft.challenges.filter((item) => item.email !== normalizedEmail || item.purpose !== purpose);
      draft.challenges.push({ email: normalizedEmail, purpose, code: '123456', used: false });
    });
    await delay(180);
    return ok({ expiresIn: 60 }, '验证码已发送');
  }),

  http.post(`${api}/auth/reset-password`, async ({ request }) => {
    const input = (await request.json()) as { email: string; code: string; password: string };
    if (!input.email.includes('@') || !/^\d{6}$/.test(input.code) || input.password.length < 12) {
      return fail(400, 'INVALID_INPUT', '邮箱、验证码或密码格式不正确。');
    }
    if (input.email.trim().toLocaleLowerCase() !== loadDb().user.email.toLocaleLowerCase()) return fail(400, 'INVALID_CODE', 'Verification code is invalid or expired');
    if (!consumeChallenge(input.email, 'reset-password', input.code)) return fail(400, 'INVALID_CODE', 'Verification code is invalid or expired');
    const passwordHash = await credentialHash(input.password);
    setCredentialHash(passwordHash);
    return ok({ success: true as const }, '密码已重置');
  }),

  http.get(`${api}/models`, () => ok(loadDb().models)),
  http.get(`${api}/generation-tasks`, () => {
    const unauthorized = authError();
    return unauthorized ?? ok(loadDb().tasks);
  }),

  http.post(`${api}/generation-quotes`, async ({ request }) => {
    const unauthorized = authError();
    if (unauthorized) return unauthorized;
    try {
      const wire = (await request.json()) as WireGenerationInput;
      return ok(presentGenerationQuote(createGenerationQuote(submittedInput(wire))), '报价已生成');
    } catch (error) {
      if (error instanceof MockFailure) return fail(error.status, error.code, error.message);
      return fail(500, 'INTERNAL_ERROR', '生成报价失败。');
    }
  }),

  http.post(`${api}/generation-tasks`, async ({ request }) => {
    const unauthorized = authError();
    if (unauthorized) return unauthorized;
    try {
      const { quoteId, input } = (await request.json()) as { quoteId: string; input: WireGenerationInput };
      return ok(submitGenerationTask(quoteId, submittedInput(input), request.headers.get('Idempotency-Key')), '任务已创建');
    } catch (error) {
      if (error instanceof MockFailure) return fail(error.status, error.code, error.message);
      return fail(500, 'INTERNAL_ERROR', '创建任务失败。');
    }
  }),

  http.post(`${api}/generation-tasks/:id/cancel`, ({ params }) => {
    const unauthorized = authError();
    if (unauthorized) return unauthorized;
    const db = mutateDb((draft) => {
      const task = draft.tasks.find((item) => item.id === params.id);
      if (task && (task.status === 'queued' || task.status === 'processing')) {
        task.status = 'cancelled';
        task.updatedAt = new Date().toISOString();
        draft.user.credits += task.estimatedCredits;
        draft.user.frozenCredits = Math.max(0, draft.user.frozenCredits - task.estimatedCredits);
        draft.ledger.unshift({ id: `ledger-${crypto.randomUUID()}`, type: 'refund', description: '任务取消退回', delta: task.estimatedCredits, balance: draft.user.credits, createdAt: task.updatedAt });
      }
    });
    const task = db.tasks.find((item) => item.id === params.id);
    return task ? ok(task, '任务已取消') : fail(404, 'INVALID_INPUT', '任务不存在。');
  }),

  http.post(`${api}/generation-tasks/:id/retry`, async ({ params, request }) => {
    const unauthorized = authError();
    if (unauthorized) return unauthorized;
    const original = loadDb().tasks.find((item) => item.id === params.id);
    if (!original) return fail(404, 'INVALID_INPUT', '任务不存在。');
    if (original.status === 'queued' || original.status === 'processing') return fail(409, 'RETRY_NOT_ALLOWED', '任务还在进行中，无法重试。');
    if (original.status === 'cancelled') return fail(409, 'RETRY_NOT_ALLOWED', '已取消的任务无法重试。');
    try {
      const { quoteId, input } = (await request.json()) as { quoteId: string; input: WireGenerationInput };
      return ok(submitGenerationTask(quoteId, submittedInput(input), request.headers.get('Idempotency-Key')), '已重新创建任务');
    } catch (error) {
      if (error instanceof MockFailure) return fail(error.status, error.code, error.message);
      return fail(500, 'INTERNAL_ERROR', '重试失败。');
    }
  }),

  http.get(`${api}/inspirations`, ({ request }) => {
    const url = new URL(request.url);
    const query = url.searchParams.get('query') ?? '';
    const category = url.searchParams.get('category') ?? '';
    const items = loadDb().inspirations.filter((item) => (!query || textMatch(`${item.title} ${item.prompt}`, query)) && (!category || item.category === category));
    // The seeded catalog fits one page, so the cursor is always exhausted.
    return ok({ items, nextCursor: null });
  }),

  http.post(`${api}/inspirations/:id/like`, ({ params }) => {
    if (!sessionUser()) return fail(401, 'AUTH_REQUIRED', '请先登录后再点赞。');
    const db = mutateDb((draft) => {
      const item = draft.inspirations.find((candidate) => candidate.id === params.id);
      if (item && !item.liked) {
        item.liked = true;
        item.likes += 1;
      }
    });
    const item = db.inspirations.find((candidate) => candidate.id === params.id);
    return item ? ok(item) : fail(404, 'INVALID_INPUT', '作品不存在。');
  }),

  http.delete(`${api}/inspirations/:id/like`, ({ params }) => {
    if (!sessionUser()) return fail(401, 'AUTH_REQUIRED', '请先登录后再取消点赞。');
    const db = mutateDb((draft) => {
      const item = draft.inspirations.find((candidate) => candidate.id === params.id);
      if (item?.liked) {
        item.liked = false;
        item.likes -= 1;
      }
    });
    const item = db.inspirations.find((candidate) => candidate.id === params.id);
    return item ? ok(item) : fail(404, 'INVALID_INPUT', '作品不存在。');
  }),

  http.post(`${api}/remix-templates/:id/favorite`, ({ params }) => {
    if (!sessionUser()) return fail(401, 'AUTH_REQUIRED', '请先登录后再收藏。');
    const db = mutateDb((draft) => {
      const item = draft.templates.find((candidate) => candidate.id === params.id);
      if (item) item.favorite = true;
    });
    const item = db.templates.find((candidate) => candidate.id === params.id);
    return item ? ok(item) : fail(404, 'TEMPLATE_UNAVAILABLE', '模板不存在。');
  }),

  http.delete(`${api}/remix-templates/:id/favorite`, ({ params }) => {
    if (!sessionUser()) return fail(401, 'AUTH_REQUIRED', '请先登录后再取消收藏。');
    const db = mutateDb((draft) => {
      const item = draft.templates.find((candidate) => candidate.id === params.id);
      if (item) item.favorite = false;
    });
    const item = db.templates.find((candidate) => candidate.id === params.id);
    return item ? ok(item) : fail(404, 'TEMPLATE_UNAVAILABLE', '模板不存在。');
  }),

  http.get(`${api}/remix-templates/:id`, ({ params }) => {
    const item = loadDb().templates.find((candidate) => candidate.id === params.id);
    return item ? ok(item) : fail(404, 'TEMPLATE_UNAVAILABLE', '模板不存在或已下架。');
  }),

  http.get(`${api}/remix-templates`, ({ request }) => {
    const url = new URL(request.url);
    const query = url.searchParams.get('query') ?? '';
    const filters = ['category', 'platform', 'industry', 'style'] as const;
    const items = loadDb().templates.filter((item) => {
      const queryMatched = !query || textMatch(`${item.title} ${item.tags.join(' ')}`, query);
      return queryMatched && filters.every((key) => !url.searchParams.get(key) || item[key] === url.searchParams.get(key));
    });
    // The seeded catalog fits one page, so the cursor is always exhausted.
    return ok({ items, nextCursor: null });
  }),

  http.post(`${api}/remix-references`, async ({ request }) => {
    const data = await request.formData();
    const file = data.get('file');
    if (!file || typeof file === 'string' || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return fail(400, 'ASSET_INVALID', '请上传 JPG、PNG 或 WebP 图片。');
    if (!file.size || file.size > 5 * 1024 * 1024) return fail(400, 'ASSET_INVALID', '图片大小须在 0 到 5MB 之间。');
    const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const signatureValid = file.type === 'image/png' ? [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)
      : file.type === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
    if (!signatureValid) return fail(400, 'ASSET_INVALID', '图片格式或内容无效，请重新上传。');
    return ok(saveReferenceUpload(file), '参考图已上传');
  }),

  http.post(`${api}/remix-tasks`, async ({ request }) => {
    const unauthorized = authError();
    if (unauthorized) return unauthorized;
    const { quoteId, input } = (await request.json()) as { quoteId: string; input: WireGenerationInput & { templateId?: string; templateVersion?: number } };
    const db = loadDb();
    const template = input.templateId ? db.templates.find((item) => item.id === input.templateId && item.status === 'active') : undefined;
    if (input.templateId && (!template || template.version !== input.templateVersion)) return fail(409, 'TEMPLATE_UNAVAILABLE', '示例已更新或不可用，请重新选择参考图。');
    const validReference = (id: string) => hasReferenceUpload(id) || db.assets.some((asset) => asset.id === id);
    if (input.referenceAssetId ? !validReference(input.referenceAssetId) : !template) return fail(400, 'ASSET_INVALID', '请上传有效的爆款参考图。');
    if (input.subjectAssetId && !validReference(input.subjectAssetId)) return fail(400, 'ASSET_INVALID', '主体素材已失效，请重新选择。');
    if (!input.prompt?.trim()) return fail(400, 'INVALID_INPUT', '请描述希望保留和修改的内容。');
    if (!['similar', 'balanced', 'creative'].includes(input.strength ?? '')) return fail(400, 'INVALID_INPUT', '请选择有效的复刻强度。');
    // A template-only remix has no upload, so the example itself stands in as the reference.
    const referenceAssetId = input.referenceAssetId ?? `template:${template!.id}`;
    try {
      const task = submitGenerationTask(
        quoteId,
        submittedInput({ ...input, referenceAssetId }),
        request.headers.get('Idempotency-Key'),
        { templateId: input.templateId, templateVersion: input.templateVersion, remixStrength: input.strength },
      );
      return ok(task, '复刻任务已创建');
    } catch (error) {
      if (error instanceof MockFailure) return fail(error.status, error.code, error.message);
      return fail(500, 'INTERNAL_ERROR', '创建复刻任务失败。');
    }
  }),

  http.post(`${api}/assets/:id/restore`, ({ params }) => {
    const unauthorized = authError();
    if (unauthorized) return unauthorized;
    const db = mutateDb((draft) => {
      const index = draft.deletedAssets.findIndex((item) => item.id === params.id);
      if (index >= 0) {
        const [asset] = draft.deletedAssets.splice(index, 1);
        draft.assets.unshift(asset);
      }
    });
    const item = db.assets.find((candidate) => candidate.id === params.id);
    return item ? ok(item, '资产已恢复') : fail(404, 'ASSET_INVALID', '资产不可恢复。');
  }),

  http.patch(`${api}/assets/:id`, async ({ params, request }) => {
    const unauthorized = authError();
    if (unauthorized) return unauthorized;
    const patch = (await request.json()) as Partial<Pick<ImageAsset, 'name' | 'favorite'>>;
    const db = mutateDb((draft) => {
      const item = draft.assets.find((candidate) => candidate.id === params.id);
      if (item) Object.assign(item, patch);
    });
    const item = db.assets.find((candidate) => candidate.id === params.id);
    return item ? ok(item, '资产已更新') : fail(404, 'ASSET_INVALID', '资产不存在。');
  }),

  http.delete(`${api}/assets/:id`, ({ params }) => {
    const unauthorized = authError();
    if (unauthorized) return unauthorized;
    let deleted: ImageAsset | undefined;
    mutateDb((draft) => {
      const index = draft.assets.findIndex((item) => item.id === params.id);
      if (index >= 0) {
        [deleted] = draft.assets.splice(index, 1);
        draft.deletedAssets.unshift(deleted);
      }
    });
    return deleted ? ok(deleted, '资产已移入回收站') : fail(404, 'ASSET_INVALID', '资产不存在。');
  }),

  http.get(`${api}/assets`, ({ request }) => {
    const unauthorized = authError();
    if (unauthorized) return unauthorized;
    const url = new URL(request.url);
    const query = url.searchParams.get('query') ?? '';
    const source = url.searchParams.get('source') ?? '';
    const favorite = url.searchParams.get('favorite') === 'true';
    const items = loadDb().assets.filter((item) => (!query || textMatch(item.name, query)) && (!source || source === '全部' || item.source === source) && (!favorite || item.favorite));
    return ok(items);
  }),

  http.get(`${api}/tools`, () => ok(loadDb().tools)),

  http.post(`${api}/tool-run-quotes`, async ({ request }) => {
    const unauthorized = authError();
    if (unauthorized) return unauthorized;
    const input = (await request.json()) as ToolQuoteInput;
    const tool = loadDb().tools.find((item) => item.id === input.toolId);
    if (!tool) return fail(404, 'INVALID_INPUT', '工具不存在。');
    if (input.toolVersion !== tool.version) return fail(409, 'TEMPLATE_UNAVAILABLE', '工具已更新，请重新报价。');
    if (input.assetIds.length < 1 || input.assetIds.length > tool.maxAssets) return fail(400, 'ASSET_INVALID', `请选择 1–${tool.maxAssets} 张${tool.assetLabel}。`);
    if (tool.fields.some((field) => field.required && !input.values[field.id])) return fail(400, 'INVALID_INPUT', '请完成所有必填项。');
    let unitCredits: number;
    let totalCredits: number;
    try {
      unitCredits = estimateCredits({ modelId: input.modelId, resolution: input.resolution, count: 1 });
      totalCredits = estimateCredits({ modelId: input.modelId, resolution: input.resolution, count: input.count });
    } catch {
      return fail(400, 'PARAMETER_UNSUPPORTED', '当前模型不支持这组生成参数。');
    }
    const now = new Date();
    const quote: MockToolQuote = {
      quoteId: `quote-${crypto.randomUUID()}`,
      toolId: tool.id,
      toolVersion: tool.version,
      modelId: input.modelId,
      resolution: input.resolution,
      ratio: input.ratio,
      count: input.count,
      unitCredits,
      totalCredits,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
      assetIds: input.assetIds,
      values: input.values,
      consumed: false,
    };
    mutateDb((draft) => {
      draft.toolQuotes.unshift(quote);
    });
    return ok(
      {
        quoteId: quote.quoteId,
        toolId: quote.toolId,
        toolVersion: quote.toolVersion,
        modelId: quote.modelId,
        resolution: quote.resolution,
        ratio: quote.ratio,
        count: quote.count,
        unitCredits: quote.unitCredits,
        totalCredits: quote.totalCredits,
        createdAt: quote.createdAt,
        expiresAt: quote.expiresAt,
      },
      '报价已生成',
    );
  }),

  http.post(`${api}/tool-runs`, async ({ request }) => {
    const unauthorized = authError();
    if (unauthorized) return unauthorized;
    const idempotencyKey = request.headers.get('Idempotency-Key');
    if (!idempotencyKey || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) return fail(400, 'INVALID_INPUT', '缺少有效的幂等键。');
    const { quoteId } = (await request.json()) as { quoteId: string };
    const quote = loadDb().toolQuotes.find((item) => item.quoteId === quoteId);
    if (!quote) return fail(404, 'INVALID_INPUT', '报价不存在。');
    if (quote.consumed) return fail(409, 'IDEMPOTENCY_CONFLICT', '报价已使用，请重新报价。');
    if (new Date(quote.expiresAt).getTime() <= Date.now()) return fail(409, 'INVALID_INPUT', '报价已过期，请重新报价。');
    const tool = loadDb().tools.find((item) => item.id === quote.toolId);
    if (!tool) return fail(404, 'INVALID_INPUT', '工具不存在。');
    try {
      mutateDb((draft) => {
        const target = draft.toolQuotes.find((item) => item.quoteId === quoteId);
        if (target) target.consumed = true;
      });
      return ok(
        createTask(
          { prompt: `${tool.name}：${Object.values(quote.values).join('，')}`, ...tool.defaults, source: 'tool' },
          { toolId: tool.id },
        ),
        '工具任务已创建',
      );
    } catch (error) {
      if (error instanceof MockFailure) return fail(error.status, error.code, error.message);
      return fail(500, 'INTERNAL_ERROR', '创建工具任务失败。');
    }
  }),

  http.post(`${api}/workflows`, async ({ request }) => {
    const unauthorized = authError();
    if (unauthorized) return unauthorized;
    const definition = (await request.json()) as WorkflowDefinition;
    const invalid = workflowDefinitionError(definition);
    if (invalid) return fail(422, 'INVALID_WORKFLOW_GRAPH', invalid);
    const workflow: Workflow = {
      id: `workflow-${crypto.randomUUID()}`,
      name: definition.name.trim(),
      version: 1,
      columns: definition.columns,
      rows: definition.rows,
      updatedAt: new Date().toISOString(),
    };
    mutateDb((draft) => {
      draft.workflows.unshift(workflow);
    });
    return ok(workflow, '工作流已创建');
  }),

  http.get(`${api}/workflows`, () => {
    const unauthorized = authError();
    return unauthorized ?? ok(loadDb().workflows);
  }),

  http.get(`${api}/workflows/:id`, ({ params }) => {
    const unauthorized = authError();
    if (unauthorized) return unauthorized;
    const workflow = loadDb().workflows.find((item) => item.id === params.id);
    return workflow ? ok(workflow) : fail(404, 'WORKFLOW_NOT_FOUND', '工作流不存在。');
  }),

  http.put(`${api}/workflows/:id`, async ({ params, request }) => {
    const unauthorized = authError();
    if (unauthorized) return unauthorized;
    const incoming = (await request.json()) as WorkflowDefinition & { version: number };
    const current = loadDb().workflows.find((item) => item.id === params.id);
    if (!current) return fail(404, 'WORKFLOW_NOT_FOUND', '工作流不存在。');
    if (current.version !== incoming.version) return fail(409, 'WORKFLOW_VERSION_CONFLICT', '工作流已被其他改动更新，请重新加载。');
    const invalid = workflowDefinitionError(incoming);
    if (invalid) return fail(422, 'INVALID_WORKFLOW_GRAPH', invalid);
    const saved: Workflow = { ...current, name: incoming.name.trim(), columns: incoming.columns, rows: incoming.rows, version: current.version + 1, updatedAt: new Date().toISOString() };
    mutateDb((draft) => {
      draft.workflows = draft.workflows.map((item) => (item.id === saved.id ? saved : item));
    });
    return ok(saved, '工作流已保存');
  }),

  http.post(`${api}/workflows/:id/copy`, ({ params }) => {
    const unauthorized = authError();
    if (unauthorized) return unauthorized;
    const source = loadDb().workflows.find((item) => item.id === params.id);
    if (!source) return fail(404, 'WORKFLOW_NOT_FOUND', '工作流不存在。');
    const copy: Workflow = {
      ...source,
      id: `workflow-${crypto.randomUUID()}`,
      name: `${source.name}（副本）`,
      version: 1,
      rows: source.rows.map((row) => ({ rowKey: row.rowKey, cells: { ...row.cells } })),
      updatedAt: new Date().toISOString(),
    };
    mutateDb((draft) => {
      draft.workflows.unshift(copy);
    });
    return ok(copy, '工作流已复制');
  }),

  http.delete(`${api}/workflows/:id`, ({ params }) => {
    const unauthorized = authError();
    if (unauthorized) return unauthorized;
    if (!loadDb().workflows.some((item) => item.id === params.id)) return fail(404, 'WORKFLOW_NOT_FOUND', '工作流不存在。');
    mutateDb((draft) => {
      draft.workflows = draft.workflows.filter((item) => item.id !== params.id);
    });
    return ok({ id: String(params.id) }, '工作流已归档');
  }),

  http.post(`${api}/workflow-run-quotes`, async ({ request }) => {
    const unauthorized = authError();
    if (unauthorized) return unauthorized;
    const input = (await request.json()) as WorkflowQuoteRequest;
    if ('retryRunId' in input) {
      const run = loadDb().workflowRuns.find((item) => item.id === input.retryRunId);
      if (!run) return fail(404, 'RUN_NOT_FOUND', '批量任务不存在。');
      if (!isTerminalRun(run.status)) return fail(409, 'RUN_NOT_SETTLED', '该批次还在运行，暂时无法重试。');
      const workflow = loadDb().workflows.find((item) => item.id === run.workflowId);
      if (!workflow) return fail(404, 'WORKFLOW_NOT_FOUND', '工作流不存在。');
      const failedItems = run.items.filter((item) => item.status === 'failed');
      if (!failedItems.length) return fail(409, 'RETRY_UNAVAILABLE', '该批次没有可重试的失败项。');
      if (failedItems.some((item) => !item.retryable)) return fail(409, 'RETRY_MISMATCH', '该批次包含不可重试的失败项。');
      return ok(runQuoteDto(priceWorkflowRun({ ...workflow, version: run.workflowVersion }, failedItems.map((item) => ({ rowKey: item.rowKey, columnKey: item.columnKey })), run.id)));
    }
    const workflow = loadDb().workflows.find((item) => item.id === input.workflowId);
    if (!workflow) return fail(404, 'WORKFLOW_NOT_FOUND', '工作流不存在。');
    const rowKeys = [...new Set(input.rowIds)];
    if (!rowKeys.length || rowKeys.some((rowKey) => !workflow.rows.some((row) => row.rowKey === rowKey))) return fail(422, 'INVALID_WORKFLOW_SELECTION', '所选行不属于这个工作流。');
    const targets = workflow.rows
      .filter((row) => rowKeys.includes(row.rowKey))
      .flatMap((row) => workflow.columns.filter((column): column is WorkflowGenerationColumn => column.type === 'generation').map((column) => ({ rowKey: row.rowKey, columnKey: column.id })));
    if (!targets.length) return fail(422, 'INVALID_WORKFLOW_SELECTION', '工作流还没有可运行的生成列。');
    return ok(runQuoteDto(priceWorkflowRun(workflow, targets, null)), '报价已生成');
  }),

  http.post(`${api}/workflow-runs`, async ({ request }) => {
    const unauthorized = authError();
    if (unauthorized) return unauthorized;
    const { quoteId } = (await request.json()) as { quoteId: string };
    try {
      return ok(submitWorkflowRun(quoteId, request.headers.get('Idempotency-Key'), null), '批量任务已创建');
    } catch (error) {
      if (error instanceof MockFailure) return fail(error.status, error.code, error.message);
      return fail(500, 'INTERNAL_ERROR', '批量任务创建失败。');
    }
  }),

  http.post(`${api}/workflow-runs/:id/retry-failed`, async ({ params, request }) => {
    const unauthorized = authError();
    if (unauthorized) return unauthorized;
    const { quoteId } = (await request.json()) as { quoteId: string };
    const run = loadDb().workflowRuns.find((item) => item.id === params.id);
    if (!run) return fail(404, 'RUN_NOT_FOUND', '批量任务不存在。');
    try {
      return ok(submitWorkflowRun(quoteId, request.headers.get('Idempotency-Key'), run.id), '重试任务已创建');
    } catch (error) {
      if (error instanceof MockFailure) return fail(error.status, error.code, error.message);
      return fail(500, 'INTERNAL_ERROR', '重试任务创建失败。');
    }
  }),

  http.post(`${api}/workflow-runs/:id/cancel`, ({ params }) => {
    const unauthorized = authError();
    if (unauthorized) return unauthorized;
    const run = loadDb().workflowRuns.find((item) => item.id === params.id);
    if (!run) return fail(404, 'RUN_NOT_FOUND', '批量任务不存在。');
    if (isTerminalRun(run.status)) return fail(409, 'RUN_ALREADY_SETTLED', '该批次已经结束。');
    const db = mutateDb((draft) => {
      const target = draft.workflowRuns.find((item) => item.id === params.id);
      if (!target) return;
      target.cancelRequested = true;
      for (const item of target.items) {
        const task = draft.tasks.find((candidate) => candidate.id === item.generationJobId);
        if (task && (task.status === 'queued' || task.status === 'processing')) {
          task.status = 'cancelled';
          task.progress = 100;
          task.cancelRequested = true;
          task.updatedAt = new Date().toISOString();
          draft.user.frozenCredits = Math.max(0, draft.user.frozenCredits - task.estimatedCredits);
          draft.user.credits += task.estimatedCredits;
        }
      }
    });
    return ok(db.workflowRuns.find((item) => item.id === params.id), '批次已取消');
  }),

  http.get(`${api}/workflow-runs`, () => {
    const unauthorized = authError();
    return unauthorized ?? ok(loadDb().workflowRuns);
  }),

  http.get(`${api}/workflow-runs/:id`, ({ params }) => {
    const unauthorized = authError();
    if (unauthorized) return unauthorized;
    const run = loadDb().workflowRuns.find((item) => item.id === params.id);
    return run ? ok(run) : fail(404, 'RUN_NOT_FOUND', '批量任务不存在。');
  }),

  http.get(`${api}/batches`, () => {
    const unauthorized = authError();
    return unauthorized ?? ok(loadDb().workflowRuns);
  }),

  http.get(`${api}/batches/:id`, ({ params }) => {
    const unauthorized = authError();
    if (unauthorized) return unauthorized;
    const run = loadDb().workflowRuns.find((item) => item.id === params.id);
    return run ? ok(run) : fail(404, 'RUN_NOT_FOUND', '批量任务不存在。');
  }),
  http.get(`${api}/plans`, () => ok(loadDb().plans)),

  http.post(`${api}/orders`, async ({ request }) => {
    if (!sessionUser()) return fail(401, 'AUTH_REQUIRED', '请先登录后再购买。');
    const input = (await request.json()) as { planId: string; channel: Order['channel'] };
    const plan = loadDb().plans.find((item) => item.id === input.planId && item.price !== null);
    if (!plan) return fail(400, 'INVALID_INPUT', '套餐不可购买。');
    const order: Order = { id: `order-${crypto.randomUUID()}`, planId: plan.id, amount: plan.price ?? 0, channel: input.channel, status: 'pending', createdAt: new Date().toISOString() };
    mutateDb((draft) => draft.orders.unshift(order));
    return ok(order, '订单已创建');
  }),

  http.post(`${api}/mock/orders/:id/complete`, ({ params }) => {
    const unauthorized = authError();
    if (unauthorized) return unauthorized;
    let completed: Order | undefined;
    mutateDb((draft) => {
      const order = draft.orders.find((item) => item.id === params.id);
      const plan = order ? draft.plans.find((item) => item.id === order.planId) : undefined;
      if (order && plan && order.status === 'pending') {
        order.status = 'succeeded';
        completed = order;
        draft.user.planId = plan.id;
        draft.user.planName = plan.name;
        const grantedCredits = plan.credits ?? 0;
        draft.user.credits += grantedCredits;
        draft.user.concurrency = plan.concurrency ?? draft.user.concurrency;
        draft.ledger.unshift({ id: `ledger-${crypto.randomUUID()}`, type: 'purchase', description: `${plan.name}到账`, delta: grantedCredits, balance: draft.user.credits, createdAt: new Date().toISOString() });
      }
    });
    return completed ? ok(completed, '模拟支付成功') : fail(400, 'INVALID_INPUT', '订单无法完成。');
  }),

  http.get(`${api}/point-ledger`, () => {
    const unauthorized = authError();
    return unauthorized ?? ok(loadDb().ledger);
  }),
  http.get(`${api}/notifications`, () => {
    const unauthorized = authError();
    return unauthorized ?? ok(loadDb().notifications);
  }),
  http.post(`${api}/notifications/:id/read`, ({ params }) => {
    const unauthorized = authError();
    if (unauthorized) return unauthorized;
    const db = mutateDb((draft) => {
      const item = draft.notifications.find((candidate) => candidate.id === params.id);
      if (item) item.read = true;
    });
    const item = db.notifications.find((candidate) => candidate.id === params.id);
    return item ? ok(item) : fail(404, 'INVALID_INPUT', '通知不存在。');
  }),
  http.post(`${api}/notifications/read-all`, () => {
    const unauthorized = authError();
    if (unauthorized) return unauthorized;
    let updated = 0;
    mutateDb((draft) => {
      for (const item of draft.notifications) {
        if (!item.read) {
          item.read = true;
          updated += 1;
        }
      }
    });
    return ok({ updated });
  }),
  http.get(`${api}/invites`, () => {
    const unauthorized = authError();
    return unauthorized ?? ok(loadDb().invites);
  }),
  http.patch(`${api}/account/profile`, async ({ request }) => {
    const unauthorized = authError();
    if (unauthorized) return unauthorized;
    const input = (await request.json()) as { username: string };
    if (!input.username.trim()) return fail(400, 'INVALID_INPUT', '用户名不能为空。');
    const db = mutateDb((draft) => {
      draft.user.username = input.username.trim();
    });
    return ok(db.user, '资料已更新');
  }),
  http.post(`${api}/account/avatar`, async ({ request }) => {
    const unauthorized = authError();
    if (unauthorized) return unauthorized;
    const file = (await request.formData()).get('file');
    if (!(file instanceof File) || !file.type.startsWith('image/')) return fail(400, 'ASSET_INVALID', '头像必须是图片。');
    const db = mutateDb((draft) => { draft.user.avatarUrl = '/api/assets/mock-avatar/content'; });
    return ok(db.user, '头像已更新');
  }),
  http.post(`${api}/account/change-email`, async ({ request }) => {
    const unauthorized = authError();
    if (unauthorized) return unauthorized;
    const input = (await request.json()) as { email: string; code: string };
    if (!input.email.includes('@')) return fail(400, 'INVALID_INPUT', '邮箱格式不正确。');
    if (!consumeChallenge(input.email, 'change-email', input.code)) return fail(400, 'INVALID_CODE', 'Verification code is invalid or expired');
    const db = mutateDb((draft) => { draft.user.email = input.email.trim(); });
    return ok(db.user, '邮箱已更新');
  }),
  http.post(`${api}/account/change-password`, async ({ request }) => {
    const unauthorized = authError();
    if (unauthorized) return unauthorized;
    const input = (await request.json()) as { code: string; password: string };
    if (input.password.length < 12) return fail(400, 'INVALID_INPUT', '密码少于 12 位。');
    if (!consumeChallenge(loadDb().user.email, 'change-password', input.code)) return fail(400, 'INVALID_CODE', 'Verification code is invalid or expired');
    const passwordHash = await credentialHash(input.password);
    setCredentialHash(passwordHash);
    return ok(loadDb().user, '密码已更新');
  }),
  http.post(`${api}/account/redeem`, async ({ request }) => {
    const unauthorized = authError();
    if (unauthorized) return unauthorized;
    const idempotencyKey = request.headers.get('Idempotency-Key');
    if (!idempotencyKey || !/^[A-Za-z0-9_-]{16,100}$/.test(idempotencyKey)) return fail(400, 'INVALID_INPUT', '缺少有效的幂等键。');
    const { code } = (await request.json()) as { code: string };
    const normalized = code.trim().toUpperCase();
    const prior = loadDb().redemptionAttempts.find((item) => item.key === idempotencyKey);
    if (prior) return prior.code === normalized ? ok(prior.user, '兑换成功') : fail(409, 'IDEMPOTENCY_CONFLICT', '幂等键已用于其他兑换码。');
    if (normalized !== 'VIVIAI2026') return fail(422, 'REDEMPTION_INVALID_OR_EXPIRED', '兑换码无效或已过期。');
    if (loadDb().redeemedCodes.includes(normalized)) return fail(422, 'REDEMPTION_LIMIT_REACHED', '兑换码已使用。');
    const db = mutateDb((draft) => {
      draft.redeemedCodes.push(normalized);
      draft.user.credits += 100;
      draft.ledger.unshift({ id: `ledger-${crypto.randomUUID()}`, type: 'redeem', description: '兑换码奖励', delta: 100, balance: draft.user.credits, createdAt: new Date().toISOString() });
      draft.notifications.unshift({ id: `notice-${crypto.randomUUID()}`, type: 'credits', title: '兑换积分到账', content: '100 积分已到账。', href: '/account', read: false, createdAt: new Date().toISOString() });
      draft.redemptionAttempts.push({ key: idempotencyKey, code: normalized, user: structuredClone(draft.user) });
    });
    return ok(db.user, '兑换成功');
  }),
  http.post(`${api}/mock/reset`, () => {
    resetDb();
    return ok({ success: true as const }, '演示数据已重置');
  }),
];
