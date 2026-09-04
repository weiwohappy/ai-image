import { estimateCredits } from '@/src/lib/pricing';
import type { Workflow } from '@/src/types/domain';

export interface WorkflowSummary {
  rows: number;
  tasks: number;
  completed: number;
  processing: number;
  failed: number;
  estimatedCredits: number;
}

export function summarizeWorkflow(workflow: Workflow, selectedRowIds: string[]): WorkflowSummary {
  const rows = workflow.rows.filter((row) => selectedRowIds.includes(row.id));
  const columns = workflow.columns.filter((column) => column.type === 'generation' && column.modelId && column.resolution);
  const estimatedCredits = columns.reduce((total, column) => total + estimateCredits({ modelId: column.modelId!, resolution: column.resolution!, count: 1 }), 0) * rows.length;
  return {
    rows: rows.length,
    tasks: rows.length * columns.length,
    completed: rows.filter((row) => row.status === 'succeeded').length * columns.length,
    processing: rows.filter((row) => row.status === 'queued' || row.status === 'processing').length * columns.length,
    failed: rows.filter((row) => row.status === 'failed').length * columns.length,
    estimatedCredits,
  };
}
