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
    vi.stubEnv('VITE_API_MODE', 'real');
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
    vi.stubEnv('VITE_API_MODE', 'real');
    vi.stubEnv('VITE_API_BASE_URL', 'http://localhost:3001/api');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ data: null, message: 'ok', requestId: 'req-api' }),
    );

    await api.getMe();

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:3001/api/me');
  });

  it('turns an API error envelope into an ApiError with its server code', async () => {
    vi.stubEnv('VITE_API_MODE', 'real');
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

  it('sends the reset-password purpose and only the file field for real uploads', async () => {
    vi.stubEnv('VITE_API_MODE', 'real');
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
    await api.uploadRemixReference(file, { width: 10, height: 20 });

    const [, codeInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(jsonBody(codeInit)).toEqual({ email: 'user@example.com', purpose: 'reset-password' });
    const [, uploadInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(uploadInit.body).toBeInstanceOf(FormData);
    expect(Array.from((uploadInit.body as FormData).keys())).toEqual(['file']);
  });
});
