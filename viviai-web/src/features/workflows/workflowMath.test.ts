import { describe, expect, it } from 'vitest';
import type { WorkflowShape } from './workflowMath';
import { summarizeWorkflow } from './workflowMath';

const workflow: WorkflowShape = {
  columns: [
    { id: 'ref', name: '商品素材', type: 'reference' },
    { id: 'result', name: '主图生成', type: 'generation', prompt: '商业商品图', sourceColumnIds: ['ref'], modelId: 'nano-banana-2', resolution: '1K', ratio: '1:1' },
  ],
  rows: [
    { rowKey: 'row-1', cells: { ref: 'asset-1' } },
    { rowKey: 'row-2', cells: { ref: 'asset-2' } },
  ],
};

describe('workflow summary', () => {
  it('estimates task counts and credits for the selected rows', () => {
    expect(summarizeWorkflow(workflow, ['row-1', 'row-2'])).toEqual({ rows: 2, tasks: 2, estimatedCredits: 8 });
  });

  it('counts nothing when no row is selected', () => {
    expect(summarizeWorkflow(workflow, [])).toEqual({ rows: 0, tasks: 0, estimatedCredits: 0 });
  });

  it('keeps estimating when a column has no price for its parameters', () => {
    const unsupported: WorkflowShape = { ...workflow, columns: [...workflow.columns, { id: 'wide', name: '4K 主图', type: 'generation', prompt: '', sourceColumnIds: ['ref'], modelId: 'nano-banana-pro', resolution: '4K', ratio: '1:1' }] };
    expect(summarizeWorkflow(unsupported, ['row-1'])).toEqual({ rows: 1, tasks: 2, estimatedCredits: 4 });
  });
});
