import { describe, it, expect, vi } from 'vitest';
import { AdminClient, AdminError } from './http';

const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ data, message: 'ok', code: 'OK', requestId: 'test-id' }), {
    status,
  });
describe('admin HTTP boundary', () => {
  it('uploads multipart media through the fixed admin boundary without setting Content-Type', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ id: 'media-1', version: 1 }));
    vi.stubGlobal('fetch', fetcher);
    const body = new FormData();
    body.set('file', new File(['image'], 'cover.png', { type: 'image/png' }));
    body.set('reason', '上传运营内容封面');
    const key = '84d10165-e83f-46ca-abbb-3bcc2a16b6c9';

    await expect(new AdminClient().upload('/content/media', body, key)).resolves.toEqual({
      id: 'media-1',
      version: 1,
    });
    const request = fetcher.mock.calls[0]![1] as RequestInit;
    expect(fetcher.mock.calls[0]![0]).toBe('/api/admin/content/media');
    expect(request.body).toBe(body);
    expect(request.headers).toMatchObject({
      Accept: 'application/json',
      'Idempotency-Key': key,
    });
    expect(request.headers).not.toHaveProperty('Content-Type');
  });

  it('retains only safe field metadata from bindable validation errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: null,
            code: 'CONTENT_NOT_PUBLISHABLE',
            message: 'private model and provider detail',
            requestId: 'safe-request',
            field: 'defaultModelId',
            details: { reason: 'not_publishable', ignored: 'private' },
          }),
          { status: 422 },
        ),
      ),
    );
    await expect(new AdminClient().get('/content/tools/tool-1')).rejects.toMatchObject({
      status: 422,
      field: 'defaultModelId',
      details: { reason: 'not_publishable' },
      message: '无法完成变更，请检查字段和当前状态',
    });
  });

  it('sends typed team mutations with a stable idempotency key and JSON version', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ resourceId: 'member-1', version: 2 }));
    vi.stubGlobal('fetch', fetcher);
    const client = new AdminClient();
    const body = { displayName: '客服同事', expectedVersion: 1, reason: '更新成员显示名称' };
    const key = 'a0d0188e-c11e-4a2f-b24b-e84607e84607';
    expect(await client.command('PATCH', '/team/members/member-1', body, key)).toEqual({
      resourceId: 'member-1',
      version: 2,
    });
    expect(fetcher).toHaveBeenCalledWith(
      '/api/admin/team/members/member-1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify(body),
        credentials: 'same-origin',
        cache: 'no-store',
        headers: expect.objectContaining({
          'Idempotency-Key': key,
          'Content-Type': 'application/json',
        }),
      }),
    );
  });
  it('retains a safe business error code without displaying the raw response message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: null,
            code: 'ADMIN_TEAM_VERSION_CONFLICT',
            message: 'private internal details',
            requestId: 'safe-id',
          }),
          { status: 409 },
        ),
      ),
    );
    await expect(new AdminClient().get('/team/members/member-1')).rejects.toMatchObject({
      code: 'ADMIN_TEAM_VERSION_CONFLICT',
      status: 409,
      requestId: 'safe-id',
      message: '状态已变化，请刷新后重试',
    });
  });
  it('uses same-origin cookies, no cache and an abort signal', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ id: 'a' }));
    vi.stubGlobal('fetch', fetcher);
    const client = new AdminClient();
    const signal = new AbortController().signal;
    expect(await client.get('/me', signal)).toEqual({ id: 'a' });
    expect(fetcher).toHaveBeenCalledWith(
      '/api/admin/me',
      expect.objectContaining({ credentials: 'same-origin', cache: 'no-store', signal }),
    );
  });
  it('rejects requests outside the fixed admin path', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    for (const path of [
      'https://example.com',
      '//example.com',
      '/../me',
      '/assets/../me',
      '/assets/%2e%2e/me',
      '/me#token',
    ]) {
      await expect(new AdminClient().get(path)).rejects.toThrow();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('invalidates once on 401 and refuses a stale protected response', async () => {
    let resolve!: (response: Response) => void;
    const fetcher = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((r) => {
            resolve = r;
          }),
      )
      .mockResolvedValueOnce(response(null, 401));
    vi.stubGlobal('fetch', fetcher);
    const client = new AdminClient();
    const invalid = vi.fn();
    client.onUnauthorized = invalid;
    const late = client.get('/users');
    await expect(client.get('/me')).rejects.toBeInstanceOf(AdminError);
    resolve(response({ secretRecord: 'stale' }));
    await expect(late).rejects.toMatchObject({ name: 'AbortError' });
    expect(invalid).toHaveBeenCalledOnce();
  });
  it('rejects invalid envelopes and never renders raw server error bodies', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('<script>provider secret</script>', { status: 502 })),
    );
    await expect(new AdminClient().get('/users')).rejects.toMatchObject({
      message: '服务暂时不可用，请稍后重试',
      status: 502,
    });
  });
  it('preserves only the safe request ID for an API error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(null, 403)));
    await expect(new AdminClient().get('/users')).rejects.toMatchObject({
      status: 403,
      requestId: 'test-id',
    });
  });
  it('accepts an official model ID containing a version dot', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(response({ id: 'gemini-3.1-flash-image-preview' })),
    );
    await expect(new AdminClient().get('/models/gemini-3.1-flash-image-preview')).resolves.toEqual({
      id: 'gemini-3.1-flash-image-preview',
    });
  });
  it('accepts the existing backend success envelope without an error code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: { enabled: false },
            message: 'success',
            requestId: 'request-1',
          }),
        ),
      ),
    );
    await expect(new AdminClient().get('/status')).resolves.toEqual({ enabled: false });
  });
});
