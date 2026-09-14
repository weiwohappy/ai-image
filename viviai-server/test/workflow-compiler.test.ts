import { describe, expect, it } from 'vitest';
import { compileWorkflowSelection } from '../src/modules/workflow/workflow-compiler.js';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

const toolDefinition = {
  externalId: 'product-background',
  version: 3,
  fieldSchema: [
    { id: 'subject', label: 'Subject', type: 'text', required: true },
    {
      id: 'style',
      label: 'Style',
      type: 'select',
      required: true,
      options: [
        { label: 'Clean', value: 'clean' },
        { label: 'Luxury', value: 'luxury' },
      ],
    },
  ],
  promptTemplate: 'A {{style}} product photo of {{subject}}',
  defaults: { modelId: 'simulation-image-v1', resolution: '1K', ratio: '1:1', count: 1 },
  maxAssets: 1,
  defaultModelId: 'simulation-image-v1',
};

const WORKFLOW_ID = '11111111-2222-4333-8444-555555555555';

function workflowWith(overrides: Record<string, unknown> = {}) {
  return {
    id: WORKFLOW_ID,
    version: 4,
    columns: [
      { id: 'ref', name: '参考图', type: 'reference' },
      {
        id: 'gen',
        name: '主图',
        type: 'generation',
        prompt: 'A clean product photo',
        sourceColumnIds: ['ref'],
        modelId: 'simulation-image-v1',
        resolution: '1K',
        ratio: '1:1',
      },
      {
        id: 'poster',
        name: '海报',
        type: 'generation',
        prompt: 'A poster',
        sourceColumnIds: [],
        modelId: 'simulation-image-v1',
        resolution: '1K',
        ratio: '1:1',
      },
      {
        id: 'styled',
        name: '工具列',
        type: 'tool',
        toolId: 'product-background',
        toolVersion: 3,
        sourceColumnIds: [],
        values: { subject: 'bottle', style: 'clean' },
      },
    ],
    rows: [
      { rowKey: 'row-1', cells: { ref: UUID_A } },
      { rowKey: 'row-2', cells: { ref: UUID_B } },
      { rowKey: 'row-3', cells: {} },
    ],
    ...overrides,
  };
}

const compile = (selection: string[], workflow = workflowWith()) =>
  compileWorkflowSelection(workflow, selection, [toolDefinition]);

describe('compileWorkflowSelection', () => {
  it('compiles every output column of every selected row in stable workflow order', () => {
    const result = compile(['row-2', 'row-1']);
    expect(result.issues).toEqual([]);
    expect(result.items.map((item) => `${item.rowKey}:${item.columnId}`)).toEqual([
      'row-1:gen',
      'row-1:poster',
      'row-1:styled',
      'row-2:gen',
      'row-2:poster',
      'row-2:styled',
    ]);
  });

  it('deduplicates repeated selections without reordering', () => {
    const once = compile(['row-1']);
    const twice = compile(['row-1', 'row-1', 'row-1']);
    expect(twice.items.map((item) => item.columnId)).toEqual(once.items.map((item) => item.columnId));
  });

  it('counts exactly one task per selected row and output column', () => {
    const workflow = workflowWith({
      rows: [
        { rowKey: 'row-1', cells: { ref: UUID_A } },
        { rowKey: 'row-2', cells: { ref: UUID_B } },
        { rowKey: 'row-3', cells: { ref: UUID_A } },
      ],
    });
    const result = compile(['row-1', 'row-2', 'row-3'], workflow);
    expect(result.issues).toEqual([]);
    expect(result.items).toHaveLength(9);
    expect(new Set(result.items.map((item) => `${item.rowKey}:${item.columnId}`)).size).toBe(9);
  });

  it('builds remix input from reference cells and create input without them', () => {
    const result = compile(['row-1']);
    const generated = result.items.find((item) => item.columnId === 'gen')!;
    expect(generated.generationInput).toMatchObject({
      source: 'remix',
      referenceAssetId: UUID_A,
      modelId: 'simulation-image-v1',
      prompt: 'A clean product photo',
      resolution: '1K',
      ratio: '1:1',
      count: 1,
    });
    const poster = result.items.find((item) => item.columnId === 'poster')!;
    expect(poster.generationInput.source).toBe('create');
    expect(poster.generationInput.referenceAssetId).toBeUndefined();
  });

  it('reports an empty reference cell instead of silently skipping the item', () => {
    const result = compile(['row-3']);
    expect(result.items.map((item) => item.columnId)).toEqual(['poster', 'styled']);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ rowKey: 'row-3', columnId: 'gen', code: 'MISSING_REFERENCE' }),
    );
  });

  it('reports a reference cell that is not an asset id', () => {
    const workflow = workflowWith({
      rows: [{ rowKey: 'row-1', cells: { ref: 'not-an-asset' } }],
    });
    const result = compile(['row-1'], workflow);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ rowKey: 'row-1', columnId: 'gen', code: 'INVALID_ASSET' }),
    );
  });

  it('reports unsupported model parameters as an item issue', () => {
    const workflow = workflowWith({
      columns: [
        { id: 'ref', name: '参考图', type: 'reference' },
        {
          id: 'gen',
          name: '主图',
          type: 'generation',
          prompt: 'A clean product photo',
          sourceColumnIds: [],
          modelId: 'not-a-real-model',
          resolution: '1K',
          ratio: '1:1',
        },
      ],
      rows: [{ rowKey: 'row-1', cells: {} }],
    });
    const result = compile(['row-1'], workflow);
    expect(result.items).toEqual([]);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ rowKey: 'row-1', columnId: 'gen', code: 'INVALID_GENERATION_INPUT' }),
    );
  });

  it('compiles a tool column through the published tool version', () => {
    const result = compile(['row-1']);
    const tool = result.items.find((item) => item.columnId === 'styled')!;
    expect(tool.generationInput).toMatchObject({
      source: 'create',
      prompt: 'A clean product photo of bottle',
      count: 1,
    });
    expect(tool.originSnapshot).toMatchObject({
      workflowId: WORKFLOW_ID,
      workflowVersion: 4,
      rowKey: 'row-1',
      columnId: 'styled',
      columnType: 'tool',
      toolId: 'product-background',
      toolVersion: 3,
      compiledPrompt: 'A clean product photo of bottle',
    });
    expect(typeof tool.originSnapshot.toolValueDigest).toBe('string');
  });

  it('reports an unavailable tool version as an item issue', () => {
    const workflow = workflowWith({
      columns: [
        { id: 'ref', name: '参考图', type: 'reference' },
        {
          id: 'styled',
          name: '工具列',
          type: 'tool',
          toolId: 'product-background',
          toolVersion: 9,
          sourceColumnIds: [],
          values: { subject: 'bottle', style: 'clean' },
        },
      ],
      rows: [{ rowKey: 'row-1', cells: {} }],
    });
    const result = compile(['row-1'], workflow);
    expect(result.items).toEqual([]);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ rowKey: 'row-1', columnId: 'styled', code: 'TOOL_UNAVAILABLE' }),
    );
  });

  it('reports invalid tool values as an item issue', () => {
    const workflow = workflowWith({
      columns: [
        { id: 'ref', name: '参考图', type: 'reference' },
        {
          id: 'styled',
          name: '工具列',
          type: 'tool',
          toolId: 'product-background',
          toolVersion: 3,
          sourceColumnIds: [],
          values: { subject: 'bottle', style: 'neon' },
        },
      ],
      rows: [{ rowKey: 'row-1', cells: {} }],
    });
    const result = compile(['row-1'], workflow);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ rowKey: 'row-1', columnId: 'styled', code: 'INVALID_TOOL_INPUT' }),
    );
  });

  it('rejects a selection naming a row the workflow does not have', () => {
    expect(() => compile(['row-1', 'ghost'])).toThrow(/not part of this workflow/i);
  });

  it('rejects an output column that consumes another output column', () => {
    const workflow = workflowWith({
      columns: [
        { id: 'ref', name: '参考图', type: 'reference' },
        {
          id: 'gen',
          name: '主图',
          type: 'generation',
          prompt: 'A clean product photo',
          sourceColumnIds: ['ref'],
          modelId: 'simulation-image-v1',
          resolution: '1K',
          ratio: '1:1',
        },
        {
          id: 'derived',
          name: '衍生',
          type: 'generation',
          prompt: 'Another photo',
          sourceColumnIds: ['gen'],
          modelId: 'simulation-image-v1',
          resolution: '1K',
          ratio: '1:1',
        },
      ],
      rows: [{ rowKey: 'row-1', cells: { ref: UUID_A } }],
    });
    expect(() => compile(['row-1'], workflow)).toThrow(/reference columns/i);
  });

  it('compiles deterministically for the same workflow and selection', () => {
    const first = compile(['row-1', 'row-2']);
    const second = compile(['row-1', 'row-2']);
    expect(second.items).toEqual(first.items);
    expect(second.issues).toEqual(first.issues);
  });
});
