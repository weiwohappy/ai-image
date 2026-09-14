import { z } from 'zod';
import { AppError } from '../../shared/http/errors.js';
import { generationDefaultsSchema } from '../content/content-contracts.js';
import { normalizeInput, type GenerationInput } from '../catalog/input-schema.js';
import { compileTool, type ToolDefinitionRow } from '../tool-execution/tool-compiler.js';
import {
  validateWorkflowGraph,
  workflowColumnArraySchema,
  type WorkflowColumn,
} from './workflow-contracts.js';

const assetIdSchema = z.uuid();

export interface WorkflowCompileRow {
  rowKey: string;
  cells: Record<string, string>;
}

export interface WorkflowCompileSource {
  id: string;
  version: number;
  columns: unknown;
  rows: WorkflowCompileRow[];
}

export interface WorkflowItemIssue {
  rowKey: string;
  columnId: string;
  code: string;
  message: string;
}

export type WorkflowOriginSnapshot = {
  workflowId: string;
  workflowVersion: number;
  rowKey: string;
  columnId: string;
  columnName: string;
  columnType: 'generation' | 'tool';
  sourceAssetIds: string[];
  compiledPrompt: string;
  toolId?: string;
  toolVersion?: number;
  toolValueDigest?: string;
};

export interface CompiledWorkflowItem {
  rowKey: string;
  columnId: string;
  columnName: string;
  generationInput: GenerationInput;
  originSnapshot: WorkflowOriginSnapshot;
}

export interface WorkflowCompilation {
  items: CompiledWorkflowItem[];
  issues: WorkflowItemIssue[];
}

/**
 * Compiles the selected rows of a stored workflow into normalized generation
 * inputs in workflow order. Unusable row/column pairs are reported as issues
 * instead of being skipped, so callers can show every problem at once.
 */
export function compileWorkflowSelection(
  workflow: WorkflowCompileSource,
  rowKeys: string[],
  tools: ToolDefinitionRow[],
): WorkflowCompilation {
  const columns = workflowColumnArraySchema.safeParse(workflow.columns);
  if (!columns.success)
    throw new AppError(500, 'WORKFLOW_DATA_INVALID', 'Stored workflow is invalid');
  validateWorkflowGraph(columns.data);

  const rowsByKey = new Map(workflow.rows.map((row) => [row.rowKey, row]));
  const selected = [...new Set(rowKeys)];
  if (selected.some((rowKey) => !rowsByKey.has(rowKey)))
    throw new AppError(422, 'INVALID_WORKFLOW_SELECTION', 'Selected rows are not part of this workflow');
  const selection = new Set(selected);

  const toolsByKey = new Map(tools.map((tool) => [toolKey(tool.externalId, tool.version), tool]));
  const items: CompiledWorkflowItem[] = [];
  const issues: WorkflowItemIssue[] = [];

  for (const row of workflow.rows) {
    if (!selection.has(row.rowKey)) continue;
    for (const column of columns.data) {
      if (column.type === 'reference') continue;
      const assets = sourceAssets(row, column.sourceColumnIds);
      if (typeof assets === 'string') {
        issues.push({ rowKey: row.rowKey, columnId: column.id, code: assets, message: assetMessage(assets) });
        continue;
      }
      const compiled =
        column.type === 'generation'
          ? compileGeneration(workflow, row, column, assets)
          : compileColumn(workflow, row, column, assets, toolsByKey);
      if (typeof compiled === 'string') {
        issues.push({ rowKey: row.rowKey, columnId: column.id, code: compiled, message: issueMessage(compiled) });
        continue;
      }
      items.push(compiled);
    }
  }

  return { items, issues };
}

type GenerationColumn = Extract<WorkflowColumn, { type: 'generation' }>;
type ToolColumn = Extract<WorkflowColumn, { type: 'tool' }>;

function compileGeneration(
  workflow: WorkflowCompileSource,
  row: WorkflowCompileRow,
  column: GenerationColumn,
  assets: string[],
): CompiledWorkflowItem | string {
  try {
    return {
      rowKey: row.rowKey,
      columnId: column.id,
      columnName: column.name,
      generationInput: normalizeInput({
        source: assets.length ? 'remix' : 'create',
        modelId: column.modelId,
        prompt: column.prompt,
        resolution: column.resolution,
        ratio: column.ratio,
        count: 1,
        ...(assets[0] ? { referenceAssetId: assets[0] } : {}),
        ...(assets[1] ? { subjectAssetId: assets[1] } : {}),
      }),
      originSnapshot: {
        workflowId: workflow.id,
        workflowVersion: workflow.version,
        rowKey: row.rowKey,
        columnId: column.id,
        columnName: column.name,
        columnType: 'generation',
        sourceAssetIds: assets,
        compiledPrompt: column.prompt,
      },
    };
  } catch {
    return 'INVALID_GENERATION_INPUT';
  }
}

function compileColumn(
  workflow: WorkflowCompileSource,
  row: WorkflowCompileRow,
  column: ToolColumn,
  assets: string[],
  tools: Map<string, ToolDefinitionRow>,
): CompiledWorkflowItem | string {
  const definition = tools.get(toolKey(column.toolId, column.toolVersion));
  if (!definition) return 'TOOL_UNAVAILABLE';
  const defaults = generationDefaultsSchema.safeParse(definition.defaults);
  if (!defaults.success) return 'TOOL_UNAVAILABLE';
  try {
    const compiled = compileTool(
      definition,
      {
        toolId: column.toolId,
        toolVersion: column.toolVersion,
        assetIds: assets,
        values: column.values,
        modelId: definition.defaultModelId,
        resolution: defaults.data.resolution,
        ratio: defaults.data.ratio,
        count: defaults.data.count,
      },
      assets,
    );
    return {
      rowKey: row.rowKey,
      columnId: column.id,
      columnName: column.name,
      generationInput: compiled.generationInput,
      originSnapshot: {
        workflowId: workflow.id,
        workflowVersion: workflow.version,
        rowKey: row.rowKey,
        columnId: column.id,
        columnName: column.name,
        columnType: 'tool',
        sourceAssetIds: assets,
        compiledPrompt: compiled.originSnapshot.compiledPrompt,
        toolId: compiled.originSnapshot.toolId,
        toolVersion: compiled.originSnapshot.toolVersion,
        toolValueDigest: compiled.originSnapshot.valueDigest,
      },
    };
  } catch {
    return 'INVALID_TOOL_INPUT';
  }
}

/** Resolves the reference cells of a row into asset ids, or returns an issue code. */
function sourceAssets(row: WorkflowCompileRow, sourceColumnIds: string[]): string[] | string {
  const assets: string[] = [];
  for (const sourceId of sourceColumnIds) {
    const value = (row.cells[sourceId] ?? '').trim();
    if (!value) return 'MISSING_REFERENCE';
    if (!assetIdSchema.safeParse(value).success) return 'INVALID_ASSET';
    assets.push(value);
  }
  return assets;
}

function toolKey(toolId: string, version: number): string {
  return `${toolId}@${version}`;
}

function assetMessage(code: string): string {
  return code === 'MISSING_REFERENCE'
    ? 'A referenced cell has no image selected'
    : 'A referenced cell does not hold an image id';
}

function issueMessage(code: string): string {
  switch (code) {
    case 'TOOL_UNAVAILABLE':
      return 'This tool version is no longer available';
    case 'INVALID_TOOL_INPUT':
      return 'This tool cannot run with the saved values';
    default:
      return 'The saved model parameters cannot be generated';
  }
}
