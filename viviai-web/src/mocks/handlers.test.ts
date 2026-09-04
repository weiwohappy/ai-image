import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { resetDb } from './db';
import { server } from './server';
import { api } from '@/src/services/api';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => resetDb());
afterAll(() => server.close());

describe('Mock generation API', () => {
  it('creates a queued task and freezes the estimated credits', async () => {
    const created = await api.createGenerationTask({
      prompt: '透明香氛瓶，暖色电影光',
      modelId: 'nano-banana-2',
      resolution: '1K',
      ratio: '1:1',
      count: 1,
    });

    expect(created.status).toBe('queued');
    expect(created.estimatedCredits).toBe(4);
    await expect(api.getMe()).resolves.toMatchObject({
      credits: 1116,
      frozenCredits: 4,
    });
  });
});
