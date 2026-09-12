const messages: Record<number, string> = {
  400: '输入格式有误，请检查后重试',
  401: '登录或验证码无效，或会话已过期',
  403: '当前账号没有此操作权限',
  404: '记录不存在或不可访问',
  409: '状态已变化，请刷新后重试',
  410: '链接或授权已过期',
  422: '无法完成变更，请检查字段和当前状态',
  429: '请求过于频繁，请稍后重试',
  503: '服务暂时不可用，请稍后重试',
};
export class AdminError extends Error {
  constructor(
    public status: number,
    public requestId?: string,
    public code?: string,
    public field?: string,
    public details?: Readonly<Record<string, string | number>>,
  ) {
    super(messages[status] ?? '服务暂时不可用，请稍后重试');
    this.name = 'AdminError';
  }
}
function adminPath(path: string): string {
  const pathname = path.split('?')[0];
  if (
    !/^\/[a-z0-9_./-]+$/i.test(pathname) ||
    pathname.includes('//') ||
    path.includes('#') ||
    pathname.split('/').some((v) => v === '.' || v === '..')
  ) {
    throw new Error('Invalid admin path');
  }
  return `/api/admin${path}`;
}
export function errorText(error: unknown): string {
  return error instanceof AdminError
    ? `${error.message}${error.requestId ? `（请求号 ${error.requestId}）` : ''}`
    : '无法连接管理服务，请检查后端配置后重试';
}
export class AdminClient {
  private generation = 0;
  onUnauthorized?: () => void;
  invalidate() {
    this.generation += 1;
  }
  get<T>(path: string, signal?: AbortSignal) {
    return this.request<T>(path, { signal });
  }
  post<T>(path: string, body: unknown, signal?: AbortSignal, authenticated = true) {
    return this.request<T>(path, { method: 'POST', body, signal, authenticated });
  }
  command<T>(
    method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    body: unknown,
    idempotencyKey: string,
    signal?: AbortSignal,
  ) {
    return this.request<T>(path, { method, body, signal, idempotencyKey });
  }
  upload<T>(path: string, body: FormData, idempotencyKey: string, signal?: AbortSignal) {
    return this.request<T>(path, { method: 'POST', body, signal, idempotencyKey });
  }
  private async request<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      signal?: AbortSignal;
      authenticated?: boolean;
      idempotencyKey?: string;
    },
  ): Promise<T> {
    const generation = this.generation;
    const response = await fetch(adminPath(path), {
      method: options.method ?? 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: options.signal,
      headers: {
        Accept: 'application/json',
        ...(options.body === undefined || options.body instanceof FormData
          ? {}
          : { 'Content-Type': 'application/json' }),
        ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
      },
      ...(options.body === undefined
        ? {}
        : { body: options.body instanceof FormData ? options.body : JSON.stringify(options.body) }),
    });
    let envelope: unknown;
    try {
      envelope = await response.json();
    } catch {
      /* Do not surface proxy/provider HTML. */
    }
    const requestId =
      envelope &&
      typeof envelope === 'object' &&
      'requestId' in envelope &&
      typeof envelope.requestId === 'string' &&
      /^[a-zA-Z0-9_-]{1,100}$/.test(envelope.requestId)
        ? envelope.requestId
        : undefined;
    const code =
      envelope &&
      typeof envelope === 'object' &&
      'code' in envelope &&
      typeof envelope.code === 'string' &&
      /^[A-Z0-9_]{1,80}$/.test(envelope.code)
        ? envelope.code
        : undefined;
    const field =
      envelope &&
      typeof envelope === 'object' &&
      'field' in envelope &&
      typeof envelope.field === 'string' &&
      /^[a-zA-Z][a-zA-Z0-9.[\]_-]{0,119}$/.test(envelope.field)
        ? envelope.field
        : undefined;
    const details = safeDetails(envelope);
    this.check(
      generation,
      response.status,
      options.authenticated !== false,
      requestId,
      code,
      field,
      details,
    );
    if (
      !envelope ||
      typeof envelope !== 'object' ||
      !('data' in envelope) ||
      !('message' in envelope) ||
      typeof envelope.message !== 'string' ||
      !('requestId' in envelope) ||
      typeof envelope.requestId !== 'string'
    )
      throw new AdminError(502);
    return envelope.data as T;
  }
  async blob(path: string, signal?: AbortSignal): Promise<Blob> {
    const generation = this.generation;
    const response = await fetch(adminPath(path), {
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
    });
    this.check(generation, response.status, true);
    if (!response.ok) throw new AdminError(response.status);
    const blob = await response.blob();
    this.check(generation, response.status, true);
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(blob.type.split(';')[0]))
      throw new AdminError(502);
    return blob;
  }
  private check(
    generation: number,
    status: number,
    authenticated: boolean,
    requestId?: string,
    code?: string,
    field?: string,
    details?: Readonly<Record<string, string | number>>,
  ) {
    if (generation !== this.generation) throw new DOMException('Session changed', 'AbortError');
    if (status === 401 && authenticated) {
      this.invalidate();
      this.onUnauthorized?.();
    }
    if (status >= 400) throw new AdminError(status, requestId, code, field, details);
  }
}

function safeDetails(envelope: unknown): Readonly<Record<string, string | number>> | undefined {
  if (!envelope || typeof envelope !== 'object' || !('details' in envelope)) return undefined;
  const value = envelope.details;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const result: Record<string, string | number> = {};
  for (const key of ['reason', 'limit', 'retryAfterSeconds']) {
    const item = source[key];
    if (typeof item === 'number' && Number.isFinite(item)) result[key] = item;
    if (typeof item === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(item)) result[key] = item;
  }
  return Object.keys(result).length ? result : undefined;
}
