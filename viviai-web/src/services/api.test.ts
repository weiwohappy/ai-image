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

  it('uses account-engagement paths, purpose-bound codes, multipart avatars, and redemption idempotency', async () => {
    vi.stubEnv('VITE_API_MODE', 'real');
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
});
