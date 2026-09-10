import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  OFFICIAL_MODELS,
  OFFICIAL_PROTOCOLS,
  officialSpecs,
  type OfficialOutputSpec,
} from './official-models.js';
import type { PriceSnapshot } from './pricing.js';
const id = z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/);
const positive = z.string().regex(/^[1-9]\d{0,14}$/);
const rate = z.string().regex(/^(0|[1-9]\d{0,14})$/);
const account = z
  .object({
    scope: id,
    credentialVersion: id,
    concurrency: z.number().int().min(1).max(4),
    maxUnknown: z.number().int().min(1).max(4),
    dailyBudgetMicros: positive,
  })
  .strict();
const pricing = z
  .object({
    version: id,
    currency: z.literal('USD'),
    rates: z.record(
      z
        .string()
        .regex(
          /^(input_text_tokens|input_image_tokens|output_text_tokens|output_image_tokens|thought_tokens)$/,
        ),
      rate,
    ),
  })
  .strict();
const model = z
  .object({
    modelId: z.enum(OFFICIAL_MODELS.map((m) => m.id)),
    sales: z.record(z.string(), z.number().int().min(1).max(1_000_000)).optional(),
    enabledResolutions: z
      .array(z.string())
      .min(1)
      .max(8)
      .refine((r) => new Set(r).size === r.length)
      .optional(),
    reserveCostMicros: positive,
    pricing,
  })
  .strict();
const schema = z
  .object({
    revision: id,
    accounts: z.object({ google: account.optional(), openai: account.optional() }).strict(),
    models: z.array(model).max(5),
  })
  .strict();
export type OfficialSettings = z.infer<typeof schema>;
export interface OfficialConfig extends OfficialSettings {
  credentials: { google?: string; openai?: string };
}
export interface ExecutionSnapshot extends OfficialOutputSpec {
  protocol: string;
  channelId: string;
  revision: string;
  upstreamModelId: string;
  pricing: PriceSnapshot;
  reserveCostMicros: string;
  provider: 'google' | 'openai';
  credentialVersion: string;
}
const invalid = () =>
  new Error('Invalid official image configuration; verify model, account and pricing fields');
export function loadOfficialConfig(env: Record<string, string | undefined>): OfficialConfig {
  const raw = env.OFFICIAL_IMAGE_MODELS_JSON;
  if (!raw || raw.trim() === '')
    return { revision: 'disabled', accounts: {}, models: [], credentials: {} };
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw invalid();
  }
  const parsed = schema.safeParse(decoded);
  if (!parsed.success) throw invalid();
  const config: OfficialConfig = { ...parsed.data, credentials: {} };
  for (const provider of ['google', 'openai'] as const) {
    if (
      config.models.some(
        (m) => OFFICIAL_MODELS.find((d) => d.id === m.modelId)?.provider === provider,
      )
    ) {
      const key = env[provider === 'google' ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY'];
      if (!key || !key.trim() || /[\r\n]/.test(key))
        throw new Error(`Missing valid ${provider} official API credential`);
      config.credentials[provider] = key;
    }
  }
  return validateOfficialConfig(config);
}
export function validateOfficialConfig(config: OfficialConfig): OfficialConfig {
  const { credentials, ...settings } = config;
  if (
    !schema.safeParse(settings).success ||
    new Set(config.models.map((m) => m.modelId)).size !== config.models.length
  )
    throw invalid();
  for (const m of config.models) {
    const definition = OFFICIAL_MODELS.find((d) => d.id === m.modelId)!;
    if (
      !config.accounts[definition.provider] ||
      !credentials[definition.provider]?.trim() ||
      /[\r\n]/.test(credentials[definition.provider]!)
    )
      throw invalid();
    const resolutions = officialSpecs(m.modelId).map((s) => s.resolution);
    const enabled = enabledResolutions(m);
    if (
      !enabled.length ||
      enabled.some((r) => !resolutions.includes(r)) ||
      Object.keys(m.sales ?? {}).some((r) => !resolutions.includes(r))
    )
      throw invalid();
    const required = [
      'input_text_tokens',
      'input_image_tokens',
      'output_text_tokens',
      'output_image_tokens',
      ...(definition.provider === 'google' ? ['thought_tokens'] : []),
    ];
    if (required.some((d) => m.pricing.rates[d as keyof typeof m.pricing.rates] === undefined))
      throw invalid();
    if (
      BigInt(m.reserveCostMicros) > BigInt(config.accounts[definition.provider]!.dailyBudgetMicros)
    )
      throw invalid();
  }
  return config;
}
export function enabledResolutions(model: OfficialSettings['models'][number]): string[] {
  return model.enabledResolutions ?? Object.keys(model.sales ?? {});
}
export function officialSnapshot(
  config: OfficialConfig | undefined,
  modelId: string,
  resolution: string,
  ratio: string,
): ExecutionSnapshot | undefined {
  const m = config?.models.find((m) => m.modelId === modelId);
  const output = officialSpecs(modelId).find(
    (s) => s.resolution === resolution && s.ratio === ratio,
  );
  if (!config || !m || !output || !enabledResolutions(m).includes(resolution)) return;
  const definition = OFFICIAL_MODELS.find((d) => d.id === modelId)!;
  const account = config.accounts[definition.provider]!;
  const protocol = OFFICIAL_PROTOCOLS[definition.provider];
  // Commercial prices never participate in execution identity.
  const executionModel = {
    modelId: m.modelId,
    enabledResolutions: [...enabledResolutions(m)].sort(),
    reserveCostMicros: m.reserveCostMicros,
    pricing: m.pricing,
  };
  const revision = createHash('sha256')
    .update(
      JSON.stringify({ revision: config.revision, m: executionModel, output, account, protocol }),
    )
    .digest('hex')
    .slice(0, 24);
  return {
    ...output,
    protocol,
    channelId: `official-${modelId}-${output.id}-${revision}`,
    revision,
    upstreamModelId: modelId,
    provider: definition.provider,
    credentialVersion: account.credentialVersion,
    pricing: m.pricing,
    reserveCostMicros: m.reserveCostMicros,
  };
}
