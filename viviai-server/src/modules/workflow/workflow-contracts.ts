import { z } from 'zod';
import { AppError } from '../../shared/http/errors.js';

const key = z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/);
const label = z.string().trim().min(1).max(80);

export const workflowResolutionSchema = z.enum(['0.5K', '1K', '2K', '4K']);
export const workflowRatioSchema = z.enum([
  '21:9',
  '16:9',
  '3:2',
  '5:4',
  '4:3',
  '1:1',
  '4:5',
  '3:4',
  '2:3',
  '9:16',
]);

export const workflowColumnSchema = z.discriminatedUnion('type', [
  z.object({ id: key, name: label, type: z.literal('reference') }).strict(),
  z
    .object({
      id: key,
      name: label,
      type: z.literal('generation'),
      prompt: z.string().trim().min(1).max(4000),
      sourceColumnIds: z.array(key).max(2),
      modelId: z.string().trim().min(1).max(80),
      resolution: workflowResolutionSchema,
      ratio: workflowRatioSchema,
    })
    .strict(),
  z
    .object({
      id: key,
      name: label,
      type: z.literal('tool'),
      toolId: z.string().trim().min(1).max(160),
      toolVersion: z.number().int().positive(),
      sourceColumnIds: z.array(key).max(8),
      values: z.record(z.string(), z.string().max(4000)),
    })
    .strict(),
]);

export const workflowColumnArraySchema = z.array(workflowColumnSchema).min(1).max(40);

const workflowRowSchema = z
  .object({ rowKey: key, cells: z.record(key, z.string().max(4096)) })
  .strict();

export const workflowDefinitionSchema = z
  .object({
    name: label,
    columns: workflowColumnArraySchema,
    rows: z.array(workflowRowSchema).max(200),
  })
  .strict();

export const workflowUpdateSchema = workflowDefinitionSchema.extend({
  version: z.number().int().positive(),
});

export type WorkflowColumn = z.infer<typeof workflowColumnSchema>;
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
export type WorkflowUpdateInput = z.infer<typeof workflowUpdateSchema>;

export function parseWorkflowDefinition(raw: unknown): WorkflowDefinition {
  const parsed = workflowDefinitionSchema.safeParse(raw);
  if (!parsed.success) throw new AppError(400, 'INVALID_INPUT', 'Workflow fields are invalid');
  validateWorkflow(parsed.data);
  return parsed.data;
}

export function parseWorkflowUpdate(raw: unknown): WorkflowUpdateInput {
  const parsed = workflowUpdateSchema.safeParse(raw);
  if (!parsed.success) throw new AppError(400, 'INVALID_INPUT', 'Workflow fields are invalid');
  validateWorkflow(parsed.data);
  return parsed.data;
}

export function validateWorkflowGraph(columns: WorkflowColumn[]): void {
  const ids = new Set<string>();
  for (const column of columns) {
    if (ids.has(column.id)) throw invalidGraph('Duplicate column id');
    ids.add(column.id);
  }
  for (const column of columns) {
    if (column.type === 'reference') continue;
    for (const sourceId of column.sourceColumnIds) {
      const source = columns.find((candidate) => candidate.id === sourceId);
      if (!source) throw invalidGraph('Source column does not exist');
      if (source.type !== 'reference')
        throw invalidGraph('Output columns may only consume reference columns');
    }
  }
}

function validateWorkflow(definition: WorkflowDefinition): void {
  validateWorkflowGraph(definition.columns);
  const columnIds = new Set(definition.columns.map((column) => column.id));
  const rowKeys = new Set<string>();
  for (const row of definition.rows) {
    if (rowKeys.has(row.rowKey)) throw invalidGraph('Duplicate row key');
    rowKeys.add(row.rowKey);
    for (const cellKey of Object.keys(row.cells))
      if (!columnIds.has(cellKey)) throw invalidGraph('Cell references an unknown column');
  }
}

function invalidGraph(message: string): AppError {
  return new AppError(422, 'INVALID_WORKFLOW_GRAPH', message);
}
