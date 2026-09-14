import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from './api';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function jsonBody(init: RequestInit): unknown {
  if (typeof init.body !== 'string') throw new Error('expected JSON request body');
  return JSON.parse(init.body);
}

describe('frontend API transport', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('uses the configured real API origin and includes the session cookie', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'http://localhost:3001');
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        jsonResponse({
          data: { id: 'user-1' },
          message: 'ok',
          requestId: 'req-1',
        }),
      );

    await expect(api.getMe()).resolves.toEqual({ id: 'user-1' });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3001/api/me',
      expect.objectContaining({
        credentials: 'include',
        headers: expect.any(Headers),
      }),
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Headers).get('Content-Type')).toBe('application/json');
  });

  it('does not duplicate or strip an existing /api base path', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'http://localhost:3001/api');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ data: null, message: 'ok', requestId: 'req-api' }),
    );

    await api.getMe();

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:3001/api/me');
  });

  it('turns an API error envelope into an ApiError with its server code', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        jsonResponse(
          {
            data: null,
            code: 'AUTH_REQUIRED',
            message: '请先登录',
            requestId: 'req-2',
          },
          { status: 401 },
        ),
      );

    await expect(api.login({ account: 'demo@example.com', password: 'password' })).rejects.toEqual(
      expect.objectContaining({
        code: 'AUTH_REQUIRED',
        status: 401,
        message: '请先登录',
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends the reset-password purpose and only the file field for uploads', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/auth/send-code')) {
        return jsonResponse({ data: { expiresIn: 60 }, message: 'ok', requestId: 'req-3' });
      }
      return jsonResponse({
        data: { id: 'asset-1', name: 'ref.png', width: 10, height: 20 },
        message: 'ok',
        requestId: 'req-4',
      });
    });

    await api.sendCode('user@example.com', 'reset-password');
    const file = new File(['bytes'], 'ref.png', { type: 'image/png' });
    await api.uploadRemixReference(file);

    const [, codeInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(jsonBody(codeInit)).toEqual({ email: 'user@example.com', purpose: 'reset-password' });
    const [, uploadInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(uploadInit.body).toBeInstanceOf(FormData);
    expect(Array.from((uploadInit.body as FormData).keys())).toEqual(['file']);
  });

  it('uses account-engagement paths, purpose-bound codes, multipart avatars, and redemption idempotency', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({
        data: { id: 'user-1', credits: 240 },
        message: 'ok',
        requestId: 'req-engagement',
      }),
    );
    const avatar = new File(['avatar'], 'avatar.png', { type: 'image/png' });

    await api.sendCode('new@example.com', 'change-email');
    await api.sendCode('current@example.com', 'change-password');
    await api.uploadAvatar(avatar);
    await api.markAllNotificationsRead();
    await api.redeemCode('VIVIAI-2026', 'redeem-attempt-1234');

    const [emailCodeUrl, emailCodeInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(emailCodeUrl).toMatch(/\/api\/auth\/send-code$/);
    expect(jsonBody(emailCodeInit)).toEqual({ email: 'new@example.com', purpose: 'change-email' });
    const [, passwordCodeInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(jsonBody(passwordCodeInit)).toEqual({ email: 'current@example.com', purpose: 'change-password' });
    const [avatarUrl, avatarInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(avatarUrl).toMatch(/\/api\/account\/avatar$/);
    expect(avatarInit.body).toBeInstanceOf(FormData);
    expect(Array.from((avatarInit.body as FormData).keys())).toEqual(['file']);
    expect((avatarInit.headers as Headers).has('Content-Type')).toBe(false);
    expect(fetchMock.mock.calls[3]?.[0]).toMatch(/\/api\/notifications\/read-all$/);
    const [redeemUrl, redeemInit] = fetchMock.mock.calls[4] as [string, RequestInit];
    expect(redeemUrl).toMatch(/\/api\/account\/redeem$/);
    expect((redeemInit.headers as Headers).get('Idempotency-Key')).toBe('redeem-attempt-1234');
    expect(jsonBody(redeemInit)).toEqual({ code: 'VIVIAI-2026' });
  });

  it('creates a tool quote with the exact server payload', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        data: { quoteId: 'quote-1', toolId: 'product-polish', totalCredits: 4 },
        message: 'ok',
        requestId: 'req-tool-quote',
      }),
    );

    await api.createToolRunQuote({
      toolId: 'product-polish',
      toolVersion: 1,
      assetIds: ['asset-1'],
      values: { productType: '护肤品' },
      modelId: 'nano-banana-2',
      resolution: '1K',
      ratio: '1:1',
      count: 1,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/tool-run-quotes$/);
    expect(init.method).toBe('POST');
    expect(jsonBody(init)).toEqual({
      toolId: 'product-polish',
      toolVersion: 1,
      assetIds: ['asset-1'],
      values: { productType: '护肤品' },
      modelId: 'nano-banana-2',
      resolution: '1K',
      ratio: '1:1',
      count: 1,
    });
  });

  it('runs a tool from a quote with an idempotency key', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        data: { id: 'task-1', input: { source: 'tool' } },
        message: 'ok',
        requestId: 'req-tool-run',
      }),
    );

    await api.runTool('quote-1', 'tool-attempt-12345678');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/tool-runs$/);
    expect(init.method).toBe('POST');
    expect((init.headers as Headers).get('Idempotency-Key')).toBe('tool-attempt-12345678');
    expect(jsonBody(init)).toEqual({ quoteId: 'quote-1' });
  });

  it('persists workflows through versioned server commands', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'http://localhost:3001');
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => jsonResponse({ data: { id: 'workflow-1', version: 2 }, message: 'ok', requestId: 'req-workflow' }));
    const definition = {
      name: '商品批量主图',
      columns: [{ id: 'out', name: '主图', type: 'generation' as const, prompt: '商业主图', sourceColumnIds: [], modelId: 'nano-banana-2', resolution: '1K' as const, ratio: '1:1' as const }],
      rows: [{ rowKey: 'row-1', cells: {} }],
    };

    await api.createWorkflow(definition);
    await api.updateWorkflow('workflow-1', { ...definition, version: 1 });
    await api.copyWorkflow('workflow-1');
    await api.archiveWorkflow('workflow-1');

    const calls = fetchMock.mock.calls as Array<[string, RequestInit]>;
    expect(calls.map(([url, init]) => [url, init.method])).toEqual([
      ['http://localhost:3001/api/workflows', 'POST'],
      ['http://localhost:3001/api/workflows/workflow-1', 'PUT'],
      ['http://localhost:3001/api/workflows/workflow-1/copy', 'POST'],
      ['http://localhost:3001/api/workflows/workflow-1', 'DELETE'],
    ]);
    expect(jsonBody(calls[0]![1])).toEqual(definition);
    // The optimistic-concurrency version travels with the update, never with a create.
    expect(jsonBody(calls[1]![1])).toEqual({ ...definition, version: 1 });
  });

  it('quotes a workflow selection and submits it with the caller idempotency key', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'http://localhost:3001');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/workflow-run-quotes')) {
        return jsonResponse({ data: { quoteId: 'quote-1', submittable: true }, message: 'ok', requestId: 'req-quote' });
      }
      return jsonResponse({ data: { id: 'run-1', workflowId: 'workflow-1' }, message: 'ok', requestId: 'req-run' });
    });

    await api.quoteWorkflowRun({ workflowId: 'workflow-1', rowIds: ['row-1', 'row-2'] });
    await api.submitWorkflowRun('quote-1', 'batch-attempt-12345678');
    await api.retryWorkflowRun('run-1', 'quote-2', 'retry-attempt-12345678');
    await api.cancelWorkflowRun('run-1');

    const calls = fetchMock.mock.calls as Array<[string, RequestInit]>;
    expect(calls.map(([url, init]) => [url, init.method])).toEqual([
      ['http://localhost:3001/api/workflow-run-quotes', 'POST'],
      ['http://localhost:3001/api/workflow-runs', 'POST'],
      ['http://localhost:3001/api/workflow-runs/run-1/retry-failed', 'POST'],
      ['http://localhost:3001/api/workflow-runs/run-1/cancel', 'POST'],
    ]);
    expect(jsonBody(calls[0]![1])).toEqual({ workflowId: 'workflow-1', rowIds: ['row-1', 'row-2'] });
    // Only commands that consume a quote carry the key, so a replay cannot double-charge.
    expect((calls[1]![1].headers as Headers).get('Idempotency-Key')).toBe('batch-attempt-12345678');
    expect(jsonBody(calls[1]![1])).toEqual({ quoteId: 'quote-1' });
    expect((calls[2]![1].headers as Headers).get('Idempotency-Key')).toBe('retry-attempt-12345678');
    expect(jsonBody(calls[2]![1])).toEqual({ quoteId: 'quote-2' });
    expect((calls[3]![1].headers as Headers).has('Idempotency-Key')).toBe(false);
  });

  it('quotes a retry of a settled batch by run id', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'http://localhost:3001');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ data: { quoteId: 'quote-2', submittable: true }, message: 'ok', requestId: 'req-retry-quote' }),
    );

    await api.quoteWorkflowRun({ retryRunId: 'run-1' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3001/api/workflow-run-quotes');
    expect(jsonBody(init)).toEqual({ retryRunId: 'run-1' });
  });
});
