import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGeneration, createRemix } from './generationFlow';

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ data, message: 'ok', requestId: crypto.randomUUID() }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const quote = {
  id: '00000000-0000-4000-8000-000000000001',
  inputHash: 'hash',
  unitCredits: 8,
  totalCredits: 8,
  priceVersion: 1,
  createdAt: '2026-09-12T10:00:00.000Z',
  expiresAt: '2026-09-12T10:05:00.000Z',
};

const task = {
  id: '00000000-0000-4000-8000-000000000002',
  input: { source: 'create', modelId: 'gpt-image-2', prompt: 'a bottle', resolution: '1K', ratio: '1:1', format: 'png', quality: 'standard', count: 1 },
  status: 'queued',
  stage: 'submitting',
  progress: 0,
  cancelRequested: false,
  estimatedCredits: 8,
  chargedCredits: 0,
  createdAt: '2026-09-12T10:00:00.000Z',
  updatedAt: '2026-09-12T10:00:00.000Z',
  resultAssetIds: [],
  items: [],
};

function jsonBody(init: RequestInit): Record<string, unknown> {
  if (typeof init.body !== 'string') throw new Error('expected JSON request body');
  return JSON.parse(init.body) as Record<string, unknown>;
}

describe('real generation flow', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('quotes before submitting a create task with a valid idempotency key', async () => {
    vi.stubEnv('VITE_API_MODE', 'real');
    vi.stubEnv('VITE_API_BASE_URL', 'http://localhost:3001');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(envelope(quote)).mockResolvedValueOnce(envelope(task));

    const result = await createGeneration({ modelId: 'gpt-image-2', prompt: 'a bottle', resolution: '1K', ratio: '1:1', count: 1 });

    expect(result.quote.totalCredits).toBe(8);
    expect(result.task.id).toBe(task.id);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [quoteUrl, quoteInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(quoteUrl).toBe('http://localhost:3001/api/generation-quotes');
    expect(jsonBody(quoteInit)).toMatchObject({ source: 'create', format: 'png', quality: 'standard' });
    const [taskUrl, taskInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(taskUrl).toBe('http://localhost:3001/api/generation-tasks');
    expect(taskInit.headers).toBeInstanceOf(Headers);
    expect((taskInit.headers as Headers).get('Idempotency-Key')).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
    expect(jsonBody(taskInit)).toEqual({ quoteId: quote.id, input: jsonBody(quoteInit) });
  });

  it('quotes a remix with the uploaded reference and optional subject', async () => {
    vi.stubEnv('VITE_API_MODE', 'real');
    vi.stubEnv('VITE_API_BASE_URL', 'http://localhost:3001');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(envelope(quote)).mockResolvedValueOnce(envelope({ ...task, input: { ...task.input, source: 'remix', referenceAssetId: '00000000-0000-4000-8000-000000000003', subjectAssetId: '00000000-0000-4000-8000-000000000004', strength: 'balanced' } }));

    await createRemix({ modelId: 'gpt-image-2', resolution: '1K', ratio: '1:1', count: 1, adaptation: 'keep the light', strength: 'balanced', referenceAssetId: '00000000-0000-4000-8000-000000000003', subjectAssetId: '00000000-0000-4000-8000-000000000004' });

    expect(jsonBody(fetchMock.mock.calls[0][1] as RequestInit)).toMatchObject({ source: 'remix', referenceAssetId: '00000000-0000-4000-8000-000000000003', subjectAssetId: '00000000-0000-4000-8000-000000000004', strength: 'balanced' });
  });
});
