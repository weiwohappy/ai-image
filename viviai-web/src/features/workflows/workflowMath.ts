import { estimateCredits } from '@/src/lib/pricing';
import type { WorkflowColumn, WorkflowGenerationColumn, WorkflowRow } from '@/src/types/domain';

export interface WorkflowSummary {
  rows: number;
  tasks: number;
  /** A local best-effort estimate; the server quote is the authoritative price. */
  estimatedCredits: number;
}

/** The slice of a workflow the summary needs, so unsaved drafts can be summarized too. */
export interface WorkflowShape {
  columns: WorkflowColumn[];
  rows: WorkflowRow[];
}

export function generationColumns(workflow: WorkflowShape): WorkflowGenerationColumn[] {
  return workflow.columns.filter((column): column is WorkflowGenerationColumn => column.type === 'generation');
}

export function summarizeWorkflow(workflow: WorkflowShape, selectedRowKeys: string[]): WorkflowSummary {
  const rows = workflow.rows.filter((row) => selectedRowKeys.includes(row.rowKey));
  const columns = generationColumns(workflow);
  let perRow = 0;
  for (const column of columns) {
    // Unsupported combinations are reported per column by the server quote instead of failing here.
    try {
      perRow += estimateCredits({ modelId: column.modelId, resolution: column.resolution, count: 1 });
    } catch {
      continue;
    }
  }
  return { rows: rows.length, tasks: rows.length * columns.length, estimatedCredits: perRow * rows.length };
}
