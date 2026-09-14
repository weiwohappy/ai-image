import { AppError } from '../../shared/http/errors.js';
import { digest, normalizeInput, type GenerationInput } from '../catalog/input-schema.js';
import { generationDefaultsSchema, toolFieldArraySchema } from '../content/content-contracts.js';
import type { ToolQuoteInput } from './tool-input.js';

export interface CompiledToolRun {
  generationInput: GenerationInput;
  originSnapshot: {
    toolId: string;
    toolVersion: number;
    valueDigest: string;
    compiledPrompt: string;
  };
}

export interface ToolDefinitionRow {
  externalId: string;
  version: number;
  fieldSchema: unknown;
  promptTemplate: string;
  defaults: unknown;
  maxAssets: number;
  defaultModelId: string;
}

const PLACEHOLDER = /\{\{([a-z][a-z0-9_-]{1,63})\}\}/g;

export function compileTool(
  definition: ToolDefinitionRow,
  input: ToolQuoteInput,
  assets: string[],
): CompiledToolRun {
  if (input.toolId !== definition.externalId)
    throw new AppError(422, 'INVALID_TOOL_INPUT', 'Tool identity does not match');
  if (input.toolVersion !== definition.version)
    throw new AppError(422, 'INVALID_TOOL_INPUT', 'Tool version is no longer available');

  const fields = toolFieldArraySchema.safeParse(definition.fieldSchema);
  if (!fields.success)
    throw new AppError(500, 'CONTENT_DATA_INVALID', 'Tool fields are unavailable');
  const defaults = generationDefaultsSchema.safeParse(definition.defaults);
  if (!defaults.success)
    throw new AppError(500, 'CONTENT_DATA_INVALID', 'Tool defaults are unavailable');

  if (assets.length > definition.maxAssets)
    throw new AppError(422, 'INVALID_TOOL_INPUT', 'Too many reference assets');
  if (assets.length !== input.assetIds.length)
    throw new AppError(422, 'INVALID_TOOL_INPUT', 'Reference assets could not be resolved');
  if (new Set(assets).size !== assets.length)
    throw new AppError(422, 'INVALID_TOOL_INPUT', 'Reference assets must be unique');

  const fieldIds = new Set(fields.data.map((field) => field.id));
  for (const key of Object.keys(input.values)) {
    if (!fieldIds.has(key))
      throw new AppError(422, 'INVALID_TOOL_INPUT', `Unknown tool field ${key}`);
  }
  for (const field of fields.data) {
    const raw = input.values[field.id];
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (field.required && !value)
      throw new AppError(422, 'INVALID_TOOL_INPUT', `Field ${field.label} is required`);
    if (!value) continue;
    if (field.type !== 'text' && field.options) {
      const allowed = new Set(field.options.map((option) => option.value));
      if (!allowed.has(value))
        throw new AppError(422, 'INVALID_TOOL_INPUT', `Invalid value for ${field.label}`);
    }
  }

  const compiledPrompt = renderPrompt(definition.promptTemplate, input.values);
  const generationInput = normalizeInput({
    source: assets.length ? 'remix' : 'create',
    modelId: input.modelId,
    prompt: compiledPrompt,
    resolution: input.resolution,
    ratio: input.ratio,
    count: input.count,
    ...(assets[0] ? { referenceAssetId: assets[0] } : {}),
    ...(assets[1] ? { subjectAssetId: assets[1] } : {}),
  });

  return {
    generationInput,
    originSnapshot: {
      toolId: definition.externalId,
      toolVersion: definition.version,
      valueDigest: digest(input.values),
      compiledPrompt,
    },
  };
}

function renderPrompt(template: string, values: Record<string, string>): string {
  const rendered = template.replace(PLACEHOLDER, (_match, fieldId: string) => values[fieldId] ?? '');
  const normalized = rendered.replace(/\s+/g, ' ').trim();
  if (!normalized)
    throw new AppError(422, 'INVALID_TOOL_INPUT', 'Compiled prompt is empty');
  if (normalized.length > 4000)
    throw new AppError(422, 'INVALID_TOOL_INPUT', 'Compiled prompt is too long');
  return normalized;
}
