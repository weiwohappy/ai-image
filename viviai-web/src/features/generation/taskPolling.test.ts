import { describe, expect, it, vi } from 'vitest';

import type { GenerationTask } from '@/src/types/domain';
import { refreshActiveTaskDetails } from './useGenerationTasks';

const task = (id: string, status: GenerationTask['status']): GenerationTask => ({
  id,
  input: { prompt: 'x', modelId: 'gpt-image-2', resolution: '1K', ratio: '1:1', count: 1 },
  status,
  progress: status === 'succeeded' ? 100 : 10,
  estimatedCredits: 1,
  chargedCredits: 0,
  createdAt: '2026-09-12T10:00:00.000Z',
  updatedAt: '2026-09-12T10:00:00.000Z',
  resultAssetIds: [],
});

describe('task detail polling', () => {
  it('refreshes only queued and processing tasks', async () => {
    const getDetail = vi.fn(async (id: string) => ({ ...task(id, 'succeeded'), progress: 100 }));
    const result = await refreshActiveTaskDetails([task('active', 'processing'), task('done', 'succeeded')], getDetail);

    expect(getDetail).toHaveBeenCalledTimes(1);
    expect(getDetail).toHaveBeenCalledWith('active');
    expect(result).toEqual([expect.objectContaining({ id: 'active', progress: 100 }), task('done', 'succeeded')]);
  });
});
