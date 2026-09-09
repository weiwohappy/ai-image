import { describe, it, expect, vi } from 'vitest';
import { AdminClient, AdminError } from './http';

const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ data, message: 'ok', code: 'OK', requestId: 'test-id' }), {
    status,
  });
describe('admin HTTP boundary', () => {
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
      vi
        .fn()
        .mockResolvedValue(
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
