import { delay, http, HttpResponse } from 'msw';

import { estimateCredits } from '@/src/lib/pricing';
import type {
  ApiErrorCode,
  BatchTask,
  GenerationInput,
  GenerationTask,
  ImageAsset,
  Order,
  RemixInput,
  User,
  Workflow,
} from '@/src/types/domain';
import { getCredentialHash, loadDb, mutateDb, resetDb, setCredentialHash, settleTask } from './db';
import { hasReferenceUpload, saveReferenceUpload } from './referenceUploads';

const api = '*/api';

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

function scheduleTask(taskId: string, scenario: string): void {
  const processingDelay = scenario === 'slow' ? 1200 : 220;
  const completionDelay = scenario === 'slow' ? 3600 : 950;
  window.setTimeout(() => {
    mutateDb((db) => {
      const task = db.tasks.find((item) => item.id === taskId);
      if (task?.status === 'queued') {
        task.status = 'processing';
        task.progress = 52;
        task.updatedAt = new Date().toISOString();
      }
    });
  }, processingDelay);
  window.setTimeout(() => {
    settleTask(taskId, scenario === 'partial-success' ? 'partial' : scenario === 'task-failure' ? 'failure' : 'success');
  }, completionDelay);
}

function createTask(
  input: GenerationInput,
  scenario: string,
  context?: Pick<GenerationTask, 'templateId' | 'templateVersion' | 'remixStrength' | 'toolId' | 'workflowId' | 'batchId' | 'workflowRowId' | 'workflowColumnId'>,
): GenerationTask {
  const user = sessionUser();
  if (!user) throw new MockFailure(401, 'AUTH_REQUIRED', '请先登录后再生成。');
  if (!input.prompt.trim()) throw new MockFailure(400, 'INVALID_INPUT', '请输入画面描述。');
  if (scenario === 'server-error') throw new MockFailure(500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试。');
  if (scenario === 'insufficient-credits') throw new MockFailure(402, 'INSUFFICIENT_CREDITS', '积分不足，请升级套餐。');

  const db = loadDb();
  const model = db.models.find((item) => item.id === input.modelId);
  if (!model || model.status !== 'available') throw new MockFailure(409, 'MODEL_UNAVAILABLE', '当前模型不可用，请选择其他模型。');
  if (activeTaskCount() >= user.concurrency) throw new MockFailure(409, 'CONCURRENCY_LIMIT', '进行中的任务已达到套餐上限。');

  let estimatedCredits: number;
  try {
    estimatedCredits = estimateCredits(input);
  } catch {
    throw new MockFailure(400, 'PARAMETER_UNSUPPORTED', '当前模型不支持这组生成参数。');
  }
  if (user.credits < estimatedCredits) throw new MockFailure(402, 'INSUFFICIENT_CREDITS', '积分不足，请升级套餐。');

  const createdAtMs = Date.now();
  const processingDelay = scenario === 'slow' ? 1200 : 220;
  const completionDelay = scenario === 'slow' ? 3600 : 950;
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
      processingAt: new Date(createdAtMs + processingDelay).toISOString(),
      completionAt: new Date(createdAtMs + completionDelay).toISOString(),
      outcome: scenario === 'partial-success' ? 'partial' : scenario === 'task-failure' ? 'failure' : 'success',
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
  scheduleTask(task.id, scenario);
  return task;
}

function textMatch(value: string, query: string): boolean {
  return value.toLocaleLowerCase().includes(query.toLocaleLowerCase());
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
    const input = (await request.json()) as { username: string; email: string; password: string; code: string };
    if (!input.username.trim() || !input.email.includes('@') || input.password.length < 8 || !/^\d{6}$/.test(input.code)) {
      return fail(400, 'INVALID_INPUT', '请完整填写有效的注册信息。');
    }
    const passwordHash = await credentialHash(input.password);
    const userId = `user-${crypto.randomUUID()}`;
    const inviteCode = `VIVI-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
    const db = mutateDb((draft) => {
      draft.user.id = userId;
      draft.user.username = input.username.trim();
      draft.user.email = input.email.trim();
      delete draft.user.avatarUrl;
      draft.user.planId = 'free';
      draft.user.planName = '免费套餐';
      draft.user.credits = 5;
      draft.user.frozenCredits = 0;
      draft.user.concurrency = 2;
      draft.user.inviteCode = inviteCode;
      draft.sessionUserId = userId;
      draft.tasks = [];
      draft.assets = [];
      draft.deletedAssets = [];
      draft.workflows = [];
      draft.batches = [];
      draft.orders = [];
      draft.invites = [];
      draft.redeemedCodes = [];
      for (const inspiration of draft.inspirations) {
        if (inspiration.liked) inspiration.likes = Math.max(0, inspiration.likes - 1);
        inspiration.liked = false;
      }
      for (const template of draft.templates) template.favorite = false;
      draft.notifications = [{ id: `notice-${crypto.randomUUID()}`, type: 'system', title: '欢迎来到 VIVIAI', content: '注册奖励已到账，开始你的第一张作品吧。', read: false, createdAt: new Date().toISOString() }];
      draft.ledger = [{
        id: `ledger-${crypto.randomUUID()}`,
        type: 'register',
        description: '注册奖励',
        delta: 5,
        balance: 5,
        createdAt: new Date().toISOString(),
      }];
    });
    setCredentialHash(passwordHash);
    return ok(db.user, '注册成功');
  }),

  http.post(`${api}/auth/send-code`, async ({ request }) => {
    const { email } = (await request.json()) as { email: string };
    if (!email.includes('@')) return fail(400, 'INVALID_INPUT', '请输入有效邮箱。');
    await delay(180);
    return ok({ expiresIn: 60 }, '验证码已发送');
  }),

  http.post(`${api}/auth/reset-password`, async ({ request }) => {
    const input = (await request.json()) as { email: string; code: string; password: string };
    if (!input.email.includes('@') || !/^\d{6}$/.test(input.code) || input.password.length < 8) {
      return fail(400, 'INVALID_INPUT', '邮箱、验证码或密码格式不正确。');
    }
    if (input.email.trim().toLocaleLowerCase() !== loadDb().user.email.toLocaleLowerCase()) return fail(404, 'INVALID_INPUT', '没有找到该邮箱对应的账户。');
    const passwordHash = await credentialHash(input.password);
    setCredentialHash(passwordHash);
    return ok({ success: true as const }, '密码已重置');
  }),

  http.get(`${api}/models`, () => ok(loadDb().models)),
  http.get(`${api}/generation-tasks`, () => {
    const unauthorized = authError();
    return unauthorized ?? ok(loadDb().tasks);
  }),

  http.post(`${api}/generation-tasks`, async ({ request }) => {
    const scenario = request.headers.get('x-mock-scenario') ?? 'happy';
    try {
      const input = (await request.json()) as GenerationInput;
      return ok(createTask({ ...input, source: input.source ?? 'generation' }, scenario), '任务已创建');
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

  http.post(`${api}/generation-tasks/:id/retry`, ({ params, request }) => {
    const unauthorized = authError();
    if (unauthorized) return unauthorized;
    const original = loadDb().tasks.find((item) => item.id === params.id);
    if (!original) return fail(404, 'INVALID_INPUT', '任务不存在。');
    try {
      return ok(createTask(original.input, request.headers.get('x-mock-scenario') ?? 'happy'), '已重新创建任务');
    } catch (error) {
      if (error instanceof MockFailure) return fail(error.status, error.code, error.message);
      return fail(500, 'INTERNAL_ERROR', '重试失败。');
    }
  }),

  http.get(`${api}/inspirations`, ({ request }) => {
    const url = new URL(request.url);
    const query = url.searchParams.get('query') ?? '';
    const category = url.searchParams.get('category') ?? '';
    const items = loadDb().inspirations.filter((item) => (!query || textMatch(`${item.title} ${item.prompt}`, query)) && (!category || category === '全部' || item.category === category));
    return ok(items);
  }),

  http.post(`${api}/inspirations/:id/like`, ({ params }) => {
    if (!sessionUser()) return fail(401, 'AUTH_REQUIRED', '请先登录后再点赞。');
    const db = mutateDb((draft) => {
      const item = draft.inspirations.find((candidate) => candidate.id === params.id);
      if (item) {
        item.liked = !item.liked;
        item.likes += item.liked ? 1 : -1;
      }
    });
    const item = db.inspirations.find((candidate) => candidate.id === params.id);
    return item ? ok(item) : fail(404, 'INVALID_INPUT', '作品不存在。');
  }),

  http.post(`${api}/remix-templates/:id/favorite`, ({ params }) => {
    if (!sessionUser()) return fail(401, 'AUTH_REQUIRED', '请先登录后再收藏。');
    const db = mutateDb((draft) => {
      const item = draft.templates.find((candidate) => candidate.id === params.id);
      if (item) item.favorite = !item.favorite;
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
      return queryMatched && filters.every((key) => !url.searchParams.get(key) || url.searchParams.get(key) === '全部' || item[key] === url.searchParams.get(key));
    });
    return ok(items);
  }),

  http.post(`${api}/remix-references`, async ({ request }) => {
    const data = await request.formData();
    const file = data.get('file');
    const width = Number(data.get('width'));
    const height = Number(data.get('height'));
    if (!file || typeof file === 'string' || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return fail(400, 'ASSET_INVALID', '请上传 JPG、PNG 或 WebP 图片。');
    if (!file.size || file.size > 5 * 1024 * 1024) return fail(400, 'ASSET_INVALID', '图片大小须在 0 到 5MB 之间。');
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return fail(400, 'ASSET_INVALID', '图片无法读取，请重新上传。');
    const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const signatureValid = file.type === 'image/png' ? [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)
      : file.type === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
    if (!signatureValid) return fail(400, 'ASSET_INVALID', '图片格式或内容无效，请重新上传。');
    return ok(saveReferenceUpload(file, width, height), '参考图已上传');
  }),

  http.post(`${api}/remix-tasks`, async ({ request }) => {
    const unauthorized = authError();
    if (unauthorized) return unauthorized;
    const scenario = request.headers.get('x-mock-scenario') ?? 'happy';
    const input = (await request.json()) as RemixInput;
    const db = loadDb();
    const template = input.templateId ? db.templates.find((item) => item.id === input.templateId && item.status === 'active') : undefined;
    if (input.templateId && (!template || template.version !== input.templateVersion)) return fail(409, 'TEMPLATE_UNAVAILABLE', '示例已更新或不可用，请重新选择参考图。');
    const validReference = (id: string) => hasReferenceUpload(id) || db.assets.some((asset) => asset.id === id);
    if (input.referenceAssetId ? !validReference(input.referenceAssetId) : !template) return fail(400, 'ASSET_INVALID', '请上传有效的爆款参考图。');
    if (input.subjectAssetId && !validReference(input.subjectAssetId)) return fail(400, 'ASSET_INVALID', '主体素材已失效，请重新选择。');
    if (!input.adaptation?.trim()) return fail(400, 'INVALID_INPUT', '请描述希望保留和修改的内容。');
    if (!['similar', 'balanced', 'creative'].includes(input.strength)) return fail(400, 'INVALID_INPUT', '请选择有效的复刻强度。');
    const referenceAssetId = input.referenceAssetId ?? `template:${template!.id}`;
    try {
      const generationInput: GenerationInput = {
        prompt: input.adaptation,
        modelId: input.modelId,
        resolution: input.resolution,
        quality: input.quality,
        ratio: input.ratio,
        count: input.count,
        referenceAssetId,
        referenceAssetIds: [referenceAssetId, ...(input.subjectAssetId ? [input.subjectAssetId] : [])],
        source: 'remix',
      };
      return ok(createTask(generationInput, scenario, { templateId: input.templateId, templateVersion: input.templateVersion, remixStrength: input.strength }), '复刻任务已创建');
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

  http.post(`${api}/tool-runs`, async ({ request }) => {
    const unauthorized = authError();
    if (unauthorized) return unauthorized;
    const input = (await request.json()) as { toolId: string; assetIds: string[]; values: Record<string, string> };
    const tool = loadDb().tools.find((item) => item.id === input.toolId);
    if (!tool) return fail(404, 'INVALID_INPUT', '工具不存在。');
    if (input.assetIds.length < 1 || input.assetIds.length > tool.maxAssets) return fail(400, 'ASSET_INVALID', `请选择 1–${tool.maxAssets} 张${tool.assetLabel}。`);
    if (tool.fields.some((field) => field.required && !input.values[field.id])) return fail(400, 'INVALID_INPUT', '请完成所有必填项。');
    try {
      return ok(
        createTask(
          { prompt: `${tool.name}：${Object.values(input.values).join('，')}`, ...tool.defaults, source: 'tool' },
          'happy',
          { toolId: tool.id },
        ),
        '工具任务已创建',
      );
    } catch (error) {
      if (error instanceof MockFailure) return fail(error.status, error.code, error.message);
      return fail(500, 'INTERNAL_ERROR', '创建工具任务失败。');
    }
  }),

  http.post(`${api}/workflows/:id/run`, async ({ params, request }) => {
    const unauthorized = authError();
    if (unauthorized) return unauthorized;
    const { rowIds } = (await request.json()) as { rowIds: string[] };
    const workflow = loadDb().workflows.find((item) => item.id === params.id);
    if (!workflow || !workflow.saved) return fail(400, 'INVALID_INPUT', '请先保存工作流。');
    const generationColumns = workflow.columns.filter((column) => column.type === 'generation' && column.modelId && column.resolution);
    const rows = workflow.rows.filter((row) => rowIds.includes(row.id));
    if (!rows.length || !generationColumns.length) return fail(400, 'INVALID_INPUT', '没有可运行的任务。');
    if (rows.length !== rowIds.length) return fail(400, 'INVALID_INPUT', '包含无效的工作流行。');
    const requiredReferenceIds = new Set(generationColumns.flatMap((column) => column.sourceColumnIds ?? []));
    if (rows.some((row) => [...requiredReferenceIds].some((columnId) => !row.cells[columnId]))) return fail(400, 'ASSET_INVALID', '请为所选行补齐参考素材。');
    const jobs = rows.flatMap((row) => generationColumns.map((column) => {
      const referenceAssetIds = column.sourceColumnIds?.map((id) => row.cells[id]).filter(Boolean) as string[] | undefined;
      const input: GenerationInput = {
        prompt: `${column.prompt?.trim() || column.name}${row.cells.brief ? `，${row.cells.brief}` : ''}`,
        modelId: column.modelId!,
        resolution: column.resolution!,
        ratio: column.ratio ?? '1:1',
        count: 1,
        referenceAssetId: referenceAssetIds?.[0],
        referenceAssetIds,
        source: 'workflow',
      };
      return { input, rowId: row.id, columnId: column.id };
    }));
    const inputs = jobs.map((job) => job.input);
    const current = loadDb();
    let estimatedCredits = 0;
    try {
      estimatedCredits = inputs.reduce((total, input) => total + estimateCredits(input), 0);
    } catch {
      return fail(400, 'PARAMETER_UNSUPPORTED', '工作流包含不支持的模型参数。');
    }
    if (inputs.some((input) => !current.models.some((model) => model.id === input.modelId && model.status === 'available'))) return fail(409, 'MODEL_UNAVAILABLE', '工作流包含不可用模型。');
    if (inputs.some((input) => input.referenceAssetIds?.some((id) => !current.assets.some((asset) => asset.id === id)))) return fail(400, 'ASSET_INVALID', '工作流包含无效参考素材。');
    if (current.user.credits < estimatedCredits) return fail(402, 'INSUFFICIENT_CREDITS', '积分不足，无法运行所选任务。');
    if (activeTaskCount() + inputs.length > current.user.concurrency) return fail(409, 'CONCURRENCY_LIMIT', '批量任务超过当前套餐并发上限。');
    const createdAt = new Date().toISOString();
    const batchId = `batch-${crypto.randomUUID()}`;
    const children = jobs.map((job) => createTask(job.input, 'happy', { workflowId: workflow.id, batchId, workflowRowId: job.rowId, workflowColumnId: job.columnId }));
    const batch: BatchTask = {
      id: batchId,
      workflowId: workflow.id,
      workflowName: workflow.name,
      total: rowIds.length * generationColumns.length,
      completed: 0,
      processing: rowIds.length * generationColumns.length,
      failed: 0,
      estimatedCredits,
      status: 'processing',
      createdAt,
      childTaskIds: children.map((task) => task.id),
    };
    mutateDb((draft) => {
      draft.batches.unshift(batch);
      const target = draft.workflows.find((item) => item.id === workflow.id);
      for (const row of target?.rows ?? []) {
        if (!rowIds.includes(row.id)) continue;
        row.status = 'processing';
        for (const column of generationColumns) delete row.cells[column.id];
      }
    });
    return ok(batch, '批量任务已创建');
  }),

  http.get(`${api}/workflows/:id`, ({ params }) => {
    const unauthorized = authError();
    if (unauthorized) return unauthorized;
    const workflow = loadDb().workflows.find((item) => item.id === params.id);
    return workflow ? ok(workflow) : fail(404, 'INVALID_INPUT', '工作流不存在。');
  }),

  http.put(`${api}/workflows/:id`, async ({ params, request }) => {
    const unauthorized = authError();
    if (unauthorized) return unauthorized;
    const incoming = (await request.json()) as Workflow;
    const saved: Workflow = { ...incoming, id: String(params.id), saved: true, version: incoming.version + 1, updatedAt: new Date().toISOString() };
    mutateDb((draft) => {
      const index = draft.workflows.findIndex((item) => item.id === saved.id);
      if (index >= 0) draft.workflows[index] = saved;
      else draft.workflows.unshift(saved);
    });
    return ok(saved, '工作流已保存');
  }),

  http.get(`${api}/workflows`, () => {
    const unauthorized = authError();
    return unauthorized ?? ok(loadDb().workflows.filter((item) => item.saved));
  }),
  http.get(`${api}/batches`, () => {
    const unauthorized = authError();
    return unauthorized ?? ok(loadDb().batches);
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
  http.get(`${api}/invites`, () => {
    const unauthorized = authError();
    return unauthorized ?? ok(loadDb().invites);
  }),
  http.patch(`${api}/account/profile`, async ({ request }) => {
    const unauthorized = authError();
    if (unauthorized) return unauthorized;
    const input = (await request.json()) as { username: string; avatarUrl?: string };
    if (!input.username.trim()) return fail(400, 'INVALID_INPUT', '用户名不能为空。');
    const db = mutateDb((draft) => {
      draft.user.username = input.username.trim();
      if (input.avatarUrl !== undefined) draft.user.avatarUrl = input.avatarUrl;
    });
    return ok(db.user, '资料已更新');
  }),
  http.post(`${api}/account/email`, async ({ request }) => {
    const unauthorized = authError();
    if (unauthorized) return unauthorized;
    const input = (await request.json()) as { email: string; code: string };
    if (!input.email.includes('@') || input.code !== '123456') return fail(400, 'INVALID_INPUT', '邮箱或验证码不正确。');
    const db = mutateDb((draft) => { draft.user.email = input.email.trim(); });
    return ok(db.user, '邮箱已更新');
  }),
  http.post(`${api}/account/password`, async ({ request }) => {
    const unauthorized = authError();
    if (unauthorized) return unauthorized;
    const input = (await request.json()) as { code: string; password: string };
    if (input.code !== '123456' || input.password.length < 8) return fail(400, 'INVALID_INPUT', '验证码错误或密码少于 8 位。');
    const passwordHash = await credentialHash(input.password);
    setCredentialHash(passwordHash);
    return ok({ success: true as const }, '密码已更新');
  }),
  http.post(`${api}/account/redeem`, async ({ request }) => {
    const unauthorized = authError();
    if (unauthorized) return unauthorized;
    const { code } = (await request.json()) as { code: string };
    const normalized = code.trim().toUpperCase();
    if (normalized !== 'VIVIAI2026' || loadDb().redeemedCodes.includes(normalized)) return fail(400, 'INVALID_INPUT', '兑换码无效或已使用。');
    const db = mutateDb((draft) => {
      draft.redeemedCodes.push(normalized);
      draft.user.credits += 100;
      draft.ledger.unshift({ id: `ledger-${crypto.randomUUID()}`, type: 'redeem', description: '兑换码奖励', delta: 100, balance: draft.user.credits, createdAt: new Date().toISOString() });
    });
    return ok(db.user, '兑换成功');
  }),
  http.post(`${api}/mock/reset`, () => {
    resetDb();
    return ok({ success: true as const }, '演示数据已重置');
  }),
];
