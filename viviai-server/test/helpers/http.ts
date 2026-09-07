export function responseCookie(response: { headers: Record<string, unknown> }): string {
  const value = response.headers['set-cookie'];
  const cookie = Array.isArray(value) ? value[0] : value;
  if (typeof cookie !== 'string' || !cookie) throw new Error('Expected a session cookie');
  return cookie;
}
export async function jsonEnvelope<T>(
  response: Response,
): Promise<{ data: T; message: string; code?: string }> {
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object' || !('data' in body) || !('message' in body))
    throw new Error('Expected JSON API envelope');
  return body as { data: T; message: string; code?: string };
}
