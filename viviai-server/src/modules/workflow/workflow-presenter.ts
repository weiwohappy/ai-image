import { z } from 'zod';
import { AppError } from '../../shared/http/errors.js';
import { workflowColumnArraySchema } from './workflow-contracts.js';

const storedCellsSchema = z.record(z.string(), z.string());

export interface WorkflowRowDto {
  rowKey: string;
  cells: Record<string, string>;
}

export interface WorkflowDto {
  id: string;
  name: string;
  version: number;
  columns: z.infer<typeof workflowColumnArraySchema>;
  rows: WorkflowRowDto[];
  updatedAt: string;
}

export interface WorkflowProjection {
  id: string;
  name: string;
  version: number;
  columns: unknown;
  updatedAt: Date;
  rows: Array<{ rowKey: string; cells: unknown }>;
}

export interface StoredWorkflowContent {
  columns: z.infer<typeof workflowColumnArraySchema>;
  rows: WorkflowRowDto[];
}

export function readStoredContent(row: {
  columns: unknown;
  rows: Array<{ rowKey: string; cells: unknown }>;
}): StoredWorkflowContent {
  const columns = workflowColumnArraySchema.safeParse(row.columns);
  if (!columns.success) throw invalidStored();
  const rows = row.rows.map((stored) => {
    const cells = storedCellsSchema.safeParse(stored.cells);
    if (!cells.success) throw invalidStored();
    return { rowKey: stored.rowKey, cells: cells.data };
  });
  return { columns: columns.data, rows };
}

const runSnapshotSchema = z.object({
  workflowId: z.uuid(),
  workflowVersion: z.number().int().positive(),
  name: z.string(),
  columns: workflowColumnArraySchema,
  rows: z.array(z.object({ rowKey: z.string(), cells: storedCellsSchema })),
});

export type WorkflowRunSnapshot = z.infer<typeof runSnapshotSchema>;

/**
 * Reads the workflow content frozen into a batch run when it was submitted, so
 * retries reproduce the version that was quoted even after later edits.
 */
export function readRunSnapshot(value: unknown): WorkflowRunSnapshot {
  const snapshot = runSnapshotSchema.safeParse(value);
  if (!snapshot.success) throw invalidStored();
  return snapshot.data;
}

export function readRunSnapshotIdentity(value: unknown) {
  const { workflowId, workflowVersion } = readRunSnapshot(value);
  return { workflowId, workflowVersion };
}

export function presentWorkflow(row: WorkflowProjection): WorkflowDto {
  const { columns, rows } = readStoredContent(row);
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    columns,
    rows,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function invalidStored(): AppError {
  return new AppError(500, 'WORKFLOW_DATA_INVALID', 'Stored workflow is invalid');
}
