import { describe, expect, it } from 'vitest';
import { compileTool } from '../src/modules/tool-execution/tool-compiler.js';
import { parseToolQuoteInput } from '../src/modules/tool-execution/tool-input.js';

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
    {
      id: 'mood',
      label: 'Mood',
      type: 'radio',
      required: false,
      options: [
        { label: 'Warm', value: 'warm' },
        { label: 'Cool', value: 'cool' },
      ],
    },
  ],
  promptTemplate: 'A {{style}} product photo of {{subject}}{{mood}}',
  defaults: { modelId: 'gemini-2.5-flash-image', resolution: '1K', ratio: '1:1', count: 1 },
  maxAssets: 1,
  defaultModelId: 'gemini-2.5-flash-image',
};

function validInput(overrides: Partial<ReturnType<typeof parseToolQuoteInput>> = {}) {
  return parseToolQuoteInput({
    toolId: 'product-background',
    toolVersion: 3,
    assetIds: [],
    values: { subject: 'a perfume bottle', style: 'clean' },
    modelId: 'gemini-2.5-flash-image',
    resolution: '1K',
    ratio: '1:1',
    count: 1,
    ...overrides,
  });
}

describe('parseToolQuoteInput', () => {
  it('accepts a well-formed quote request', () => {
    expect(validInput()).toMatchObject({ toolId: 'product-background', toolVersion: 3 });
  });

  it('rejects malformed requests', () => {
    expect(() =>
      parseToolQuoteInput({ toolId: 'UPPERCASE', toolVersion: 3, assetIds: [], values: {} }),
    ).toThrow();
    expect(() =>
      parseToolQuoteInput({ toolId: 'product-background', toolVersion: 0, assetIds: [], values: {} }),
    ).toThrow();
    expect(() =>
      parseToolQuoteInput({
        toolId: 'product-background',
        toolVersion: 3,
        assetIds: [],
        values: {},
        count: 9,
      }),
    ).toThrow();
  });
});

describe('compileTool', () => {
  it('compiles a text-only create generation', () => {
    const input = validInput({ assetIds: [], values: { subject: 'a perfume bottle', style: 'clean' } });
    const compiled = compileTool(toolDefinition, input, []);
    expect(compiled.generationInput).toMatchObject({
      source: 'create',
      modelId: 'gemini-2.5-flash-image',
      prompt: 'A clean product photo of a perfume bottle',
      resolution: '1K',
      ratio: '1:1',
      count: 1,
    });
    expect(compiled.generationInput.referenceAssetId).toBeUndefined();
    expect(compiled.originSnapshot).toMatchObject({
      toolId: 'product-background',
      toolVersion: 3,
      compiledPrompt: 'A clean product photo of a perfume bottle',
    });
  });

  it('selects remix with one reference asset and two with reference plus subject', () => {
    const one = compileTool(toolDefinition, validInput({ assetIds: [UUID_A] }), [UUID_A]);
    expect(one.generationInput.source).toBe('remix');
    expect(one.generationInput.referenceAssetId).toBe(UUID_A);
    expect(one.generationInput.subjectAssetId).toBeUndefined();

    const two = compileTool(
      { ...toolDefinition, maxAssets: 2 },
      validInput({ assetIds: [UUID_A, UUID_B] }),
      [UUID_A, UUID_B],
    );
    expect(two.generationInput.referenceAssetId).toBe(UUID_A);
    expect(two.generationInput.subjectAssetId).toBe(UUID_B);
  });

  it('rejects a required field that is missing', () => {
    expect(() =>
      compileTool(toolDefinition, validInput({ values: { style: 'clean' } }), []),
    ).toThrow(/required/i);
  });

  it('rejects an unknown field key', () => {
    expect(() =>
      compileTool(toolDefinition, validInput({ values: { subject: 'x', style: 'clean', extra: 'y' } }), []),
    ).toThrow(/unknown/i);
  });

  it('rejects an invalid select or radio option value', () => {
    expect(() =>
      compileTool(toolDefinition, validInput({ values: { subject: 'x', style: 'neon' } }), []),
    ).toThrow();
  });

  it('enforces the tool max asset count', () => {
    expect(() =>
      compileTool(toolDefinition, validInput({ assetIds: [UUID_A, UUID_B] }), [UUID_A, UUID_B]),
    ).toThrow(/asset/i);
  });

  it('rejects duplicated reference and subject assets', () => {
    expect(() =>
      compileTool(
        { ...toolDefinition, maxAssets: 2 },
        validInput({ assetIds: [UUID_A, UUID_A] }),
        [UUID_A],
      ),
    ).toThrow();
  });

  it('substitutes values literally without evaluating injected expressions', () => {
    const hostile = 'x${1+1} {{subject}}';
    const compiled = compileTool(
      toolDefinition,
      validInput({ values: { subject: hostile, style: 'clean' } }),
      [],
    );
    expect(compiled.generationInput.prompt).toBe(
      `A clean product photo of x\${1+1} {{subject}}`,
    );
  });

  it('substitutes optional missing values as empty and normalizes whitespace', () => {
    const compiled = compileTool(
      toolDefinition,
      validInput({ values: { subject: '  a   bottle  ', style: 'clean' } }),
      [],
    );
    expect(compiled.generationInput.prompt).toBe('A clean product photo of a bottle');
  });

  it('produces deterministic compilation and value digests', () => {
    const values = { subject: 'a perfume bottle', style: 'clean' };
    const first = compileTool(toolDefinition, validInput({ values }), []);
    const second = compileTool(toolDefinition, validInput({ values }), []);
    expect(first.generationInput.prompt).toBe(second.generationInput.prompt);
    expect(first.originSnapshot.valueDigest).toBe(second.originSnapshot.valueDigest);
  });

  it('rejects a compiled prompt exceeding 4000 characters', () => {
    expect(() =>
      compileTool(
        toolDefinition,
        validInput({ values: { subject: 'a'.repeat(3990), style: 'clean' } }),
        [],
      ),
    ).toThrow(/long/i);
  });

  it('rejects a mismatched tool version', () => {
    expect(() =>
      compileTool({ ...toolDefinition, version: 4 }, validInput(), []),
    ).toThrow(/version/i);
  });
});
