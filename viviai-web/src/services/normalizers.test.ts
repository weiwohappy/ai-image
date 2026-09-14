import { afterEach, describe, expect, it, vi } from 'vitest';

import { normalizeAssetDto, normalizeModelDto, normalizeTaskDto } from './normalizers';

describe('backend DTO normalizers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('preserves the server model specs including exact pixels and 0.5K', () => {
    const model = normalizeModelDto({
      id: 'gemini-3.1-flash-image',
      name: 'Nano Banana 2',
      simulated: false,
      resolutions: ['0.5K', '1K'],
      ratios: ['1:1', '16:9'],
      formats: ['png'],
      unitCredits: 8,
      maxReferenceImages: 2,
      specs: [
        { id: 'png-0_5k-1x1-v1', resolution: '0.5K', ratio: '1:1', width: 512, height: 512 },
        { id: 'png-1k-16x9-v1', resolution: '1K', ratio: '16:9', width: 1376, height: 768, imageSize: '1K' },
      ],
    });

    expect(model).toMatchObject({
      id: 'gemini-3.1-flash-image',
      resolutions: ['0.5K', '1K'],
      ratios: ['1:1', '16:9'],
      specs: [
        { id: 'png-0_5k-1x1-v1', width: 512, height: 512 },
        { id: 'png-1k-16x9-v1', width: 1376, height: 768, imageSize: '1K' },
      ],
    });
  });

  it('maps backend create source and task items to the UI task contract', () => {
    const task = normalizeTaskDto({
      id: 'job-1',
      input: { source: 'create', modelId: 'gpt-image-2', prompt: 'a bottle', resolution: '1K', ratio: '1:1', format: 'png', quality: 'standard', count: 1 },
      status: 'processing',
      stage: 'submitting',
      progress: 0,
      cancelRequested: false,
      estimatedCredits: 10,
      chargedCredits: 0,
      createdAt: '2026-09-12T10:00:00.000Z',
      updatedAt: '2026-09-12T10:00:01.000Z',
      resultAssetIds: [],
      items: [{ id: 'item-1', ordinal: 0, status: 'processing', resultAssetId: null, errorCode: null }],
    });

    expect(task).toMatchObject({ status: 'processing', stage: 'submitting', input: { source: 'generation' }, items: [{ id: 'item-1' }] });
  });

  it('resolves relative private asset content URLs against the configured API', () => {
    vi.stubEnv('VITE_API_BASE_URL', 'http://localhost:3001');
    const asset = normalizeAssetDto({
      id: 'asset-1',
      name: 'bottle',
      width: 1024,
      height: 1024,
      status: 'ready',
      previewUrl: '/api/assets/asset-1/content',
      imageUrl: '/api/assets/asset-1/content',
      thumbnailUrl: '/api/assets/asset-1/content',
      source: 'generation',
      favorite: false,
      createdAt: '2026-09-12T10:00:00.000Z',
      deletedAt: null,
    });

    expect(asset).toMatchObject({
      imageUrl: 'http://localhost:3001/api/assets/asset-1/content',
      thumbnailUrl: 'http://localhost:3001/api/assets/asset-1/content',
    });
  });
});
