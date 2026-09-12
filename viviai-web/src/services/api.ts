import type {
  BatchTask,
  GenerationInput,
  GenerationTask,
  GenerationQuote,
  ImageAsset,
  Inspiration,
  InviteRelation,
  NotificationItem,
  Order,
  Plan,
  RemixInput,
  ToolTemplate,
  User,
  UploadedReference,
  ViralTemplate,
  Workflow,
} from '@/src/types/domain';
import { normalizeAssetDto, normalizeLedgerDtos, normalizeModelDto, normalizeTaskDto } from './normalizers';

interface ApiEnvelope<T> {
  data: T;
  message: string;
  requestId: string;
}

export type ApiMode = 'mock' | 'real';

export interface ApiConfig {
  mode: ApiMode;
  baseUrl: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function getApiConfig(): ApiConfig {
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {};
  const processEnv = typeof process !== 'undefined' ? process.env : undefined;
  const mode: ApiMode = (processEnv?.VITE_API_MODE ?? env.VITE_API_MODE) === 'real' ? 'real' : 'mock';
  const configuredBase = (processEnv?.VITE_API_BASE_URL ?? env.VITE_API_BASE_URL)?.trim().replace(/\/+$/, '');
  const fallback = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
  return { mode, baseUrl: configuredBase || fallback };
}

export function isRealApi(): boolean {
  return getApiConfig().mode === 'real';
}

function apiUrl(path: string): string {
  const { baseUrl } = getApiConfig();
  const apiPath = `/api${path.startsWith('/') ? path : `/${path}`}`;
  return joinApiPath(baseUrl, apiPath);
}

export function apiResourceUrl(path: string): string {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(path)) return path;
  const { baseUrl } = getApiConfig();
  const normalized = path.startsWith('/') ? path : `/${path}`;
  const apiPath = normalized.startsWith('/api') ? normalized : `/api${normalized}`;
  return joinApiPath(baseUrl, apiPath);
}

function joinApiPath(baseUrl: string, apiPath: string): string {
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/+$/, '');
  const suffix = basePath === '/api' ? apiPath.slice('/api'.length) : apiPath;
  return new URL(`${basePath}${suffix || '/'}`, base.origin).toString();
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!(init?.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(apiUrl(path), {
    ...init,
    credentials: 'include',
    headers,
  });
  const contentType = response.headers.get('content-type') ?? '';
  const body = contentType.includes('json')
    ? ((await response.json()) as Partial<ApiEnvelope<T>> & { code?: string })
    : { message: await response.text() };
  if (!response.ok) {
    if (response.status === 401 && typeof window !== 'undefined') window.dispatchEvent(new Event('viviai:auth-expired'));
    throw new ApiError(body.message ?? '请求失败，请稍后重试。', body.code ?? 'INTERNAL_ERROR', response.status);
  }
  if (!contentType.includes('json') || !('data' in body)) {
    throw new ApiError('服务返回了无法识别的响应。', 'INVALID_RESPONSE', response.status);
  }
  return body.data as T;
}

function queryString(params?: Record<string, string | number | boolean | undefined>): string {
  if (!params) return '';
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== '') search.set(key, String(value));
  });
  const result = search.toString();
  return result ? `?${result}` : '';
}

export const api = {
  getMe: async () => {
    try {
      return await request<User>('/me');
    } catch (error) {
      if (error instanceof ApiError && error.code === 'AUTH_REQUIRED') return null;
      throw error;
    }
  },
  login: (input: { account: string; password: string }) => request<User>('/auth/login', { method: 'POST', body: JSON.stringify(input) }),
  logout: () => request<null>('/auth/logout', { method: 'POST' }),
  register: (input: { username: string; email: string; password: string; code: string }) => request<User>('/auth/register', { method: 'POST', body: JSON.stringify(input) }),
  sendCode: (email: string, purpose: 'register' | 'reset-password' = 'register') => request<{ expiresIn: number }>('/auth/send-code', { method: 'POST', body: JSON.stringify({ email, purpose }) }),
  resetPassword: (input: { email: string; code: string; password: string }) => request<{ success: true }>('/auth/reset-password', { method: 'POST', body: JSON.stringify(input) }),
  listModels: async () => (await request<unknown[]>('/models')).map(normalizeModelDto),
  createGenerationQuote: (input: unknown) => request<GenerationQuote>('/generation-quotes', { method: 'POST', body: JSON.stringify(input) }),
  submitGenerationTask: async (operation: 'generation' | 'remix', quoteId: string, input: unknown, idempotencyKey: string) => normalizeTaskDto(await request<unknown>(operation === 'remix' ? '/remix-tasks' : '/generation-tasks', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ quoteId, input }) })),
  listGenerationTasks: async () => (await request<unknown[]>('/generation-tasks')).map(normalizeTaskDto),
  getGenerationTask: async (id: string) => normalizeTaskDto(await request<unknown>(`/generation-tasks/${encodeURIComponent(id)}`)),
  createGenerationTask: (input: GenerationInput, scenario?: string) => request<GenerationTask>('/generation-tasks', { method: 'POST', body: JSON.stringify(input), headers: scenario ? { 'x-mock-scenario': scenario } : undefined }),
  cancelGenerationTask: async (id: string) => normalizeTaskDto(await request<unknown>(`/generation-tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST' })),
  retryGenerationTask: async (id: string, payload?: { quoteId: string; input: unknown; idempotencyKey: string }) => normalizeTaskDto(await request<unknown>(`/generation-tasks/${encodeURIComponent(id)}/retry`, { method: 'POST', ...(payload ? { headers: { 'Idempotency-Key': payload.idempotencyKey }, body: JSON.stringify({ quoteId: payload.quoteId, input: payload.input }) } : {}) })),
  listInspirations: (params?: Record<string, string | undefined>) => request<Inspiration[]>(`/inspirations${queryString(params)}`),
  likeInspiration: (id: string) => request<Inspiration>(`/inspirations/${id}/like`, { method: 'POST' }),
  listTemplates: (params?: Record<string, string | undefined>) => request<ViralTemplate[]>(`/remix-templates${queryString(params)}`),
  getTemplate: (id: string) => request<ViralTemplate>(`/remix-templates/${id}`),
  toggleTemplateFavorite: (id: string) => request<ViralTemplate>(`/remix-templates/${id}/favorite`, { method: 'POST' }),
  createRemixTask: (input: RemixInput, scenario?: string) => request<GenerationTask>('/remix-tasks', { method: 'POST', body: JSON.stringify(input), headers: scenario ? { 'x-mock-scenario': scenario } : undefined }),
  uploadRemixReference: (file: File, dimensions?: { width: number; height: number }) => {
    const body = new FormData();
    body.set('file', file);
    if (!isRealApi() && dimensions) {
      body.set('width', String(dimensions.width));
      body.set('height', String(dimensions.height));
    }
    return request<unknown>('/remix-references', { method: 'POST', body }).then((value) => {
      const asset = normalizeAssetDto(value);
      return { id: asset.id, name: asset.name, width: asset.width, height: asset.height } satisfies UploadedReference;
    });
  },
  listAssets: async (params?: Record<string, string | boolean | undefined>) => (await request<unknown[]>(`/assets${queryString(isRealApi() ? { favorite: params?.favorite } : params)}`)).map(normalizeAssetDto),
  updateAsset: async (id: string, patch: Partial<Pick<ImageAsset, 'name' | 'favorite'>>) => normalizeAssetDto(await request<unknown>(`/assets/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) })),
  deleteAsset: async (id: string) => normalizeAssetDto(await request<unknown>(`/assets/${encodeURIComponent(id)}`, { method: 'DELETE' })),
  restoreAsset: async (id: string) => normalizeAssetDto(await request<unknown>(`/assets/${encodeURIComponent(id)}/restore`, { method: 'POST' })),
  listTools: () => request<ToolTemplate[]>('/tools'),
  runTool: (input: { toolId: string; assetIds: string[]; values: Record<string, string> }) => request<GenerationTask>('/tool-runs', { method: 'POST', body: JSON.stringify(input) }),
  listWorkflows: () => request<Workflow[]>('/workflows'),
  getWorkflow: (id: string) => request<Workflow>(`/workflows/${id}`),
  saveWorkflow: (workflow: Workflow) => request<Workflow>(`/workflows/${workflow.id}`, { method: 'PUT', body: JSON.stringify(workflow) }),
  runWorkflow: (id: string, rowIds: string[]) => request<BatchTask>(`/workflows/${id}/run`, { method: 'POST', body: JSON.stringify({ rowIds }) }),
  listBatches: () => request<BatchTask[]>('/batches'),
  listPlans: () => request<Plan[]>('/plans'),
  createOrder: (input: { planId: string; channel: Order['channel'] }) => request<Order>('/orders', { method: 'POST', body: JSON.stringify(input) }),
  completeMockOrder: (id: string) => request<Order>(`/mock/orders/${id}/complete`, { method: 'POST' }),
  listPointLedger: async () => normalizeLedgerDtos(await request<unknown[]>('/point-ledger')),
  listNotifications: () => request<NotificationItem[]>('/notifications'),
  markNotificationRead: (id: string) => request<NotificationItem>(`/notifications/${id}/read`, { method: 'POST' }),
  listInvites: () => request<InviteRelation[]>('/invites'),
  updateProfile: (input: { username: string; avatarUrl?: string }) => request<User>('/account/profile', { method: 'PATCH', body: JSON.stringify(input) }),
  changeEmail: (input: { email: string; code: string }) => request<User>('/account/email', { method: 'POST', body: JSON.stringify(input) }),
  changePassword: (input: { code: string; password: string }) => request<{ success: true }>('/account/password', { method: 'POST', body: JSON.stringify(input) }),
  redeemCode: (code: string) => request<User>('/account/redeem', { method: 'POST', body: JSON.stringify({ code }) }),
  resetDemoData: () => request<{ success: true }>('/mock/reset', { method: 'POST' }),
};
