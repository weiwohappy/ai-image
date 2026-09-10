import { vi } from 'vitest';
import { actor, json } from '../test/fixtures';
import type { ModelPriceRow } from './contracts';
export const pricingActor = {
  ...actor,
  roles: ['super_admin'],
  permissions: ['dashboard.read', 'models.read', 'model-pricing.write'],
};
export function priceRow(overrides: Partial<ModelPriceRow> = {}): ModelPriceRow {
  return {
    modelId: 'gpt-image-2',
    name: 'GPT Image 2',
    provider: 'openai',
    resolution: '1K',
    specs: [{ id: 'gpt-1k-square', resolution: '1K', ratio: '1:1', width: 1024, height: 1024 }],
    priceId: null,
    unitCredits: null,
    enabled: false,
    version: 0,
    updatedAt: null,
    runtimeAvailable: false,
    availabilityReason: 'unpriced' as const,
    allowedActions: (['create', 'edit', 'enable', 'disable'] as const).map((action) => ({
      action,
      allowed: true,
      reasonCode: null,
    })),
    ...overrides,
  };
}
export function setupPricingApi(
  options: {
    row?: ReturnType<typeof priceRow>;
    writeEnabled?: boolean;
    failOnce?: number;
    loseOnce?: boolean;
  } = {},
) {
  let row = options.row ?? priceRow();
  const commands: { method: string; path: string; key: string; body: Record<string, unknown> }[] =
    [];
  const requests: string[] = [];
  const events: Record<string, unknown>[] = [];
  const fetcher = vi.fn(async (raw: string, init?: RequestInit) => {
    const url = new URL(String(raw), 'http://localhost:3010');
    const path = url.pathname.replace('/api/admin', '');
    const method = init?.method ?? 'GET';
    requests.push(String(raw));
    if (method === 'GET') {
      if (path.endsWith('/history'))
        return json({ items: events, nextCursor: null, asOf: '2026-09-10T00:00:00Z' });
      if (path === '/model-pricing')
        return json({
          items: [row],
          writeEnabled: options.writeEnabled !== false,
          asOf: '2026-09-10T00:00:00Z',
        });
      return json(row);
    }
    const body = JSON.parse(String(init?.body));
    const key = new Headers(init?.headers).get('Idempotency-Key') ?? '';
    commands.push({ method, path, key, body });
    if (commands.length === 1 && options.loseOnce) throw new TypeError('Disconnected');
    if (commands.length === 1 && options.failOnce) {
      row = { ...row, unitCredits: 180, enabled: true, version: 2 };
      return new Response(
        JSON.stringify({
          data: null,
          code: options.failOnce === 409 ? 'PRICE_VERSION_CONFLICT' : 'ADMIN_FORBIDDEN',
          message: 'internal',
          requestId: 'test',
        }),
        { status: options.failOnce },
      );
    }
    const before = row.priceId
      ? { unitCredits: row.unitCredits, enabled: row.enabled, version: row.version }
      : null;
    row = {
      ...row,
      unitCredits: body.unitCredits,
      enabled: body.enabled,
      priceId: 'price-1',
      version: row.version + 1,
      updatedAt: '2026-09-10T01:00:00Z',
    };
    events.unshift({
      id: 'event-1',
      modelId: row.modelId,
      resolution: row.resolution,
      actor: '测试管理员',
      action: 'model-pricing.save',
      createdAt: '2026-09-10T01:00:00Z',
      before,
      after: { unitCredits: row.unitCredits, enabled: row.enabled, version: row.version },
    });
    return json({ resourceId: row.priceId, version: row.version });
  });
  vi.stubGlobal('fetch', fetcher);
  return { commands, requests, fetcher };
}
