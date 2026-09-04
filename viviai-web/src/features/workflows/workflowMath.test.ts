import { describe, expect, it } from 'vitest';
import type { Workflow } from '@/src/types/domain';
import { summarizeWorkflow } from './workflowMath';

const workflow: Workflow = {
  id: 'workflow-test',
  name: '商品批量主图',
  version: 0,
  saved: false,
  updatedAt: new Date().toISOString(),
  columns: [
    { id: 'ref', name: '商品素材', type: 'reference' },
    { id: 'result', name: '主图生成', type: 'generation', prompt: '商业商品图', modelId: 'nano-banana-2', resolution: '1K', ratio: '1:1' },
  ],
  rows: [
    { id: 'row-1', cells: { ref: 'asset-1' }, selected: true, status: 'idle' },
    { id: 'row-2', cells: { ref: 'asset-2' }, selected: true, status: 'idle' },
  ],
};

describe('workflow summary', () => {
  it('estimates task counts and credits for selected rows', () => {
    expect(summarizeWorkflow(workflow, ['row-1', 'row-2'])).toEqual({ rows: 2, tasks: 2, completed: 0, processing: 0, failed: 0, estimatedCredits: 8 });
  });
});
