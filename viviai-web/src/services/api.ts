import type {
  BatchTask,
  GenerationInput,
  GenerationTask,
  ImageAsset,
  Inspiration,
  InviteRelation,
  ModelConfig,
  NotificationItem,
  Order,
  Plan,
  PointLedgerEntry,
  RemixInput,
  ToolTemplate,
  User,
  ViralTemplate,
  Workflow,
} from '@/src/types/domain';

interface ApiEnvelope<T> {
  data: T;
  message: string;
  requestId: string;
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

function apiUrl(path: string): string {
  const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
  return new URL(`/api${path}`, origin).toString();
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(apiUrl(path), {
    ...init,
    headers,
  });
  const body = (await response.json()) as ApiEnvelope<T> & { code?: string };
  if (!response.ok) throw new ApiError(body.message, body.code ?? 'INTERNAL_ERROR', response.status);
  return body.data;
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
  getMe: () => request<User | null>('/me'),
  login: (input: { account: string; password: string }) => request<User>('/auth/login', { method: 'POST', body: JSON.stringify(input) }),
  logout: () => request<null>('/auth/logout', { method: 'POST' }),
  register: (input: { username: string; email: string; password: string; code: string }) => request<User>('/auth/register', { method: 'POST', body: JSON.stringify(input) }),
  sendCode: (email: string) => request<{ expiresIn: number }>('/auth/send-code', { method: 'POST', body: JSON.stringify({ email }) }),
  resetPassword: (input: { email: string; code: string; password: string }) => request<{ success: true }>('/auth/reset-password', { method: 'POST', body: JSON.stringify(input) }),
  listModels: () => request<ModelConfig[]>('/models'),
  listGenerationTasks: () => request<GenerationTask[]>('/generation-tasks'),
  createGenerationTask: (input: GenerationInput, scenario?: string) => request<GenerationTask>('/generation-tasks', { method: 'POST', body: JSON.stringify(input), headers: scenario ? { 'x-mock-scenario': scenario } : undefined }),
  cancelGenerationTask: (id: string) => request<GenerationTask>(`/generation-tasks/${id}/cancel`, { method: 'POST' }),
  retryGenerationTask: (id: string) => request<GenerationTask>(`/generation-tasks/${id}/retry`, { method: 'POST' }),
  listInspirations: (params?: Record<string, string | undefined>) => request<Inspiration[]>(`/inspirations${queryString(params)}`),
  likeInspiration: (id: string) => request<Inspiration>(`/inspirations/${id}/like`, { method: 'POST' }),
  listTemplates: (params?: Record<string, string | undefined>) => request<ViralTemplate[]>(`/remix-templates${queryString(params)}`),
  getTemplate: (id: string) => request<ViralTemplate>(`/remix-templates/${id}`),
  toggleTemplateFavorite: (id: string) => request<ViralTemplate>(`/remix-templates/${id}/favorite`, { method: 'POST' }),
  createRemixTask: (input: RemixInput, scenario?: string) => request<GenerationTask>('/remix-tasks', { method: 'POST', body: JSON.stringify(input), headers: scenario ? { 'x-mock-scenario': scenario } : undefined }),
  listAssets: (params?: Record<string, string | boolean | undefined>) => request<ImageAsset[]>(`/assets${queryString(params)}`),
  updateAsset: (id: string, patch: Partial<Pick<ImageAsset, 'name' | 'favorite'>>) => request<ImageAsset>(`/assets/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteAsset: (id: string) => request<ImageAsset>(`/assets/${id}`, { method: 'DELETE' }),
  restoreAsset: (id: string) => request<ImageAsset>(`/assets/${id}/restore`, { method: 'POST' }),
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
  listPointLedger: () => request<PointLedgerEntry[]>('/point-ledger'),
  listNotifications: () => request<NotificationItem[]>('/notifications'),
  markNotificationRead: (id: string) => request<NotificationItem>(`/notifications/${id}/read`, { method: 'POST' }),
  listInvites: () => request<InviteRelation[]>('/invites'),
  updateProfile: (input: { username: string; avatarUrl?: string }) => request<User>('/account/profile', { method: 'PATCH', body: JSON.stringify(input) }),
  changeEmail: (input: { email: string; code: string }) => request<User>('/account/email', { method: 'POST', body: JSON.stringify(input) }),
  changePassword: (input: { code: string; password: string }) => request<{ success: true }>('/account/password', { method: 'POST', body: JSON.stringify(input) }),
  redeemCode: (code: string) => request<User>('/account/redeem', { method: 'POST', body: JSON.stringify({ code }) }),
  resetDemoData: () => request<{ success: true }>('/mock/reset', { method: 'POST' }),
};
