import { z } from 'zod';

const externalId = z.string().regex(/^[a-z][a-z0-9-]{1,79}$/);
const modelId = z.string().regex(/^[a-z][a-z0-9.-]{1,79}$/);
const outputSpecId = z.string().regex(/^[a-z][a-z0-9_-]{1,79}$/);
const label = z.string().trim().min(1).max(160);
const optionalSource = z.string().trim().min(1).max(160).optional();

export const lifecycleSchema = z.enum(['draft', 'published', 'offline', 'archived']);

const sourceSchema = z
  .object({
    creatorName: optionalSource,
    sourceType: optionalSource,
    sourceName: optionalSource,
    sourceUrl: z.string().url().max(2048).optional(),
  })
  .strict();

export const contentMediaInputSchema = z
  .object({
    externalId,
    logicalFilename: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,119}$/),
    seed: z.string().trim().min(1).max(80),
    colors: z.tuple([
      z.string().regex(/^#[0-9a-f]{6}$/i),
      z.string().regex(/^#[0-9a-f]{6}$/i),
      z.string().regex(/^#[0-9a-f]{6}$/i),
    ]),
    status: lifecycleSchema,
  })
  .strict();

export const generationDefaultsSchema = z
  .object({
    modelId,
    resolution: z.enum(['0.5K', '1K', '2K', '4K']),
    ratio: z.enum(['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']),
    count: z.number().int().min(1).max(4),
  })
  .strict();

export const inspirationInputSchema = z
  .object({
    externalId,
    title: label,
    description: z.string().trim().min(1).max(2000),
    category: label,
    editorialLabel: label.optional(),
    baseLikes: z.number().int().min(0).max(1_000_000),
    tags: z.array(label).max(20),
    defaultPrompt: z.string().trim().min(1).max(4000),
    defaultModelId: modelId,
    defaultOutputSpecId: outputSpecId,
    coverMediaExternalId: externalId,
    caseMediaExternalId: externalId.optional(),
    status: lifecycleSchema,
    sortOrder: z.number().int().min(0).max(1_000_000),
  })
  .extend(sourceSchema.shape)
  .strict();

export const visualAnalysisSchema = z
  .object({
    composition: z.string().trim().min(1).max(1000),
    palette: z
      .array(z.string().regex(/^#[0-9a-f]{6}$/i))
      .min(1)
      .max(12),
    lighting: z.string().trim().min(1).max(1000),
    camera: z.string().trim().min(1).max(1000),
    typographyZone: z.string().trim().min(1).max(1000),
    avoid: z.array(label).max(20),
  })
  .strict();

export const remixTemplateInputSchema = z
  .object({
    externalId,
    title: label,
    description: z.string().trim().min(1).max(2000),
    category: label,
    platform: label,
    industry: label,
    style: label,
    popularityLabel: label.optional(),
    baseRemixCount: z.number().int().min(0).max(1_000_000),
    tags: z.array(label).max(20),
    visualAnalysis: visualAnalysisSchema,
    defaultPrompt: z.string().trim().min(1).max(4000),
    defaultParameters: z
      .object({ strength: z.enum(['similar', 'balanced', 'creative']).optional() })
      .strict(),
    defaultModelId: modelId,
    defaultOutputSpecId: outputSpecId,
    coverMediaExternalId: externalId,
    referenceMediaExternalId: externalId.optional(),
    status: lifecycleSchema,
    sortOrder: z.number().int().min(0).max(1_000_000),
  })
  .extend(sourceSchema.shape)
  .strict();

export const toolFieldSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/),
    label: z.string().trim().min(1).max(80),
    type: z.enum(['text', 'select', 'radio']),
    required: z.boolean(),
    options: z
      .array(
        z
          .object({
            label: z.string().trim().min(1).max(80),
            value: z.string().trim().min(1).max(160),
          })
          .strict(),
      )
      .min(1)
      .max(40)
      .optional(),
  })
  .strict()
  .superRefine((field, context) => {
    if (field.type === 'text' && field.options !== undefined)
      context.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'Text fields cannot define options',
      });
    if (field.type !== 'text' && !field.options?.length)
      context.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'Choice fields require options',
      });
    if (
      field.options &&
      new Set(field.options.map((option) => option.value)).size !== field.options.length
    )
      context.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'Option values must be unique',
      });
  });

export const toolFieldArraySchema = z
  .array(toolFieldSchema)
  .max(20)
  .superRefine((fields, context) => {
    if (new Set(fields.map((field) => field.id)).size !== fields.length)
      context.addIssue({
        code: 'custom',
        message: 'Tool field IDs must be unique',
      });
  });

export const toolDefinitionInputSchema = z
  .object({
    externalId,
    name: label,
    description: z.string().trim().min(1).max(2000),
    category: label,
    fields: toolFieldArraySchema,
    promptTemplate: z.string().trim().min(1).max(4000),
    defaults: generationDefaultsSchema,
    maxAssets: z.number().int().min(0).max(4),
    maxOutputCount: z.number().int().min(1).max(4),
    assetLabel: label,
    defaultModelId: modelId,
    defaultOutputSpecId: outputSpecId,
    coverMediaExternalId: externalId,
    iconMediaExternalId: externalId.optional(),
    isNew: z.boolean().default(false),
    status: lifecycleSchema,
    sortOrder: z.number().int().min(0).max(1_000_000),
  })
  .extend(sourceSchema.shape)
  .strict()
  .superRefine((tool, context) => {
    if (tool.defaults.modelId !== tool.defaultModelId)
      context.addIssue({
        code: 'custom',
        path: ['defaults', 'modelId'],
        message: 'Defaults model must match tool model',
      });
    const placeholders = [...tool.promptTemplate.matchAll(/{{([a-z][a-z0-9_-]{1,63})}}/g)].map(
      (match) => match[1]!,
    );
    if (tool.promptTemplate.replace(/{{[a-z][a-z0-9_-]{1,63}}}/g, '').match(/{{|}}/))
      context.addIssue({
        code: 'custom',
        path: ['promptTemplate'],
        message: 'Malformed prompt token',
      });
    const fieldIds = new Set(tool.fields.map((field) => field.id));
    for (const placeholder of placeholders)
      if (!fieldIds.has(placeholder))
        context.addIssue({
          code: 'custom',
          path: ['promptTemplate'],
          message: `Unknown field ${placeholder}`,
        });
  });

export const contentSeedManifestSchema = z
  .object({
    media: z.array(contentMediaInputSchema).min(1).max(100),
    inspirations: z.array(inspirationInputSchema).max(100),
    templates: z.array(remixTemplateInputSchema).max(100),
    tools: z.array(toolDefinitionInputSchema).max(100),
  })
  .strict()
  .superRefine((manifest, context) => {
    for (const [name, rows] of Object.entries(manifest) as Array<
      [string, Array<{ externalId: string }>]
    >)
      if (new Set(rows.map((row) => row.externalId)).size !== rows.length)
        context.addIssue({ code: 'custom', path: [name], message: 'External IDs must be unique' });
    const mediaIds = new Set(manifest.media.map((media) => media.externalId));
    const checkMedia = (id: string | undefined, path: (string | number)[]) => {
      if (id && !mediaIds.has(id))
        context.addIssue({ code: 'custom', path, message: `Unknown content media ${id}` });
    };
    manifest.inspirations.forEach((row, index) => {
      checkMedia(row.coverMediaExternalId, ['inspirations', index, 'coverMediaExternalId']);
      checkMedia(row.caseMediaExternalId, ['inspirations', index, 'caseMediaExternalId']);
    });
    manifest.templates.forEach((row, index) => {
      checkMedia(row.coverMediaExternalId, ['templates', index, 'coverMediaExternalId']);
      checkMedia(row.referenceMediaExternalId, ['templates', index, 'referenceMediaExternalId']);
    });
    manifest.tools.forEach((row, index) => {
      checkMedia(row.coverMediaExternalId, ['tools', index, 'coverMediaExternalId']);
      checkMedia(row.iconMediaExternalId, ['tools', index, 'iconMediaExternalId']);
    });
  });

export type ContentSeedManifest = z.infer<typeof contentSeedManifestSchema>;
