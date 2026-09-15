import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  OFFICIAL_MODELS,
  OFFICIAL_PROTOCOLS,
  OPENAI_IMAGES_MODEL_IDS,
  officialSpecs,
  type OfficialModelId,
} from './official-models.js';
import type { PriceSnapshot } from './pricing.js';

const identifier = z.string().regex(/^[a-zA-Z0-9._-]{1,120}$/);

export interface ThirdPartyProviderConfig {
  readonly id: 'sub2api';
  readonly kind: 'third_party';
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly modelId: string;
  readonly scope: string;
  readonly credentialVersion: string;
  readonly concurrency: number;
  readonly maxUnknown: number;
  readonly dailyBudgetMicros: string;
}

export interface ThirdPartyImageModelConfig {
  // Widened from the literal 'gpt-image-2': the schema admits every model whose transport
  // contract is OpenAI Images. The runtime gate in thirdPartyImageSnapshot re-checks it.
  readonly modelId: string;
  readonly enabledResolutions: readonly string[];
  readonly reserveCostMicros: string;
  readonly pricing: PriceSnapshot;
}

export interface ThirdPartyImageConfig extends Pick<
  ThirdPartyProviderConfig,
  | 'id'
  | 'kind'
  | 'baseUrl'
  | 'apiKey'
  | 'scope'
  | 'credentialVersion'
  | 'concurrency'
  | 'maxUnknown'
  | 'dailyBudgetMicros'
> {
  readonly revision: string;
  readonly models: readonly ThirdPartyImageModelConfig[];
}

const required = z
  .object({
    SUB2API_BASE_URL: z.string().url(),
    SUB2API_API_KEY: z
      .string()
      .trim()
      .min(1)
      .refine((value) => !/[\r\n]/.test(value)),
    SUB2API_MODEL_ID: identifier,
    SUB2API_SCOPE: identifier.default('sub2api-default'),
    SUB2API_CREDENTIAL_VERSION: identifier.default('v1'),
    SUB2API_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
    SUB2API_MAX_UNKNOWN: z.coerce.number().int().min(1).max(4).default(1),
    SUB2API_DAILY_BUDGET_MICROS: z
      .string()
      .regex(/^(0|[1-9]\d{0,14})$/)
      .default('0'),
  })
  .strict();

function invalid(message = 'Invalid Sub2API configuration') {
  return new Error(`${message}; verify SUB2API_BASE_URL, SUB2API_API_KEY and SUB2API_MODEL_ID`);
}

const imagePricing = z
  .object({
    version: identifier,
    currency: z.literal('USD'),
    rates: z
      .record(z.string(), z.string().regex(/^(0|[1-9]\d{0,14})$/))
      .refine(
        (rates) =>
          ['input_text_tokens', 'input_image_tokens', 'output_image_tokens'].every(
            (key) => rates[key] !== undefined,
          ),
        'image pricing must include input and output image rates',
      ),
  })
  .strict();

const imageSchema = z
  .object({
    revision: identifier,
    models: z
      .array(
        z
          .object({
            // Sub2API is wired to the OpenAI Images contract, so it carries exactly the models
            // whose protocol is openai-images-v1. Gemini/Nano Banana needs the Google
            // Interactions contract unless a third-party contract is separately verified;
            // accepting that ID here would produce a false capability.
            modelId: z.enum([...OPENAI_IMAGES_MODEL_IDS]),
            enabledResolutions: z
              .array(z.string())
              .min(1)
              .max(8)
              .refine((values) => new Set(values).size === values.length),
            reserveCostMicros: z.string().regex(/^[1-9]\d{0,14}$/),
            pricing: imagePricing,
          })
          .strict(),
      )
      .min(1)
      .max(5),
  })
  .strict();

export function normalizeOpenAICompatibleBaseUrl(raw: string, nodeEnv = 'development'): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw invalid('Sub2API base URL must be an HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol))
    throw invalid('Sub2API base URL must be an HTTP(S) URL');
  if (parsed.username || parsed.password || parsed.search || parsed.hash)
    throw invalid('Sub2API base URL must not contain credentials, query, or fragment');
  if (nodeEnv === 'production' && parsed.protocol !== 'https:')
    throw invalid('Sub2API base URL must use HTTPS in production');
  const pathname = parsed.pathname.replace(/\/+$/, '');
  if (pathname !== '' && pathname !== '/v1')
    throw invalid('Sub2API base URL path must be empty or /v1');
  return `${parsed.origin}${pathname || '/v1'}`;
}

export function loadThirdPartyConfig(
  env: Record<string, string | undefined>,
  nodeEnv = env.NODE_ENV ?? 'development',
): ThirdPartyProviderConfig | undefined {
  const enabled = env.SUB2API_ENABLED === 'true';
  if (!enabled) return undefined;
  const parsed = required.safeParse({
    SUB2API_BASE_URL: env.SUB2API_BASE_URL,
    SUB2API_API_KEY: env.SUB2API_API_KEY,
    SUB2API_MODEL_ID: env.SUB2API_MODEL_ID,
    SUB2API_SCOPE: env.SUB2API_SCOPE,
    SUB2API_CREDENTIAL_VERSION: env.SUB2API_CREDENTIAL_VERSION,
    SUB2API_CONCURRENCY: env.SUB2API_CONCURRENCY,
    SUB2API_MAX_UNKNOWN: env.SUB2API_MAX_UNKNOWN,
    SUB2API_DAILY_BUDGET_MICROS: env.SUB2API_DAILY_BUDGET_MICROS,
  });
  if (!parsed.success) throw invalid();
  return {
    id: 'sub2api',
    kind: 'third_party',
    baseUrl: normalizeOpenAICompatibleBaseUrl(parsed.data.SUB2API_BASE_URL, nodeEnv),
    apiKey: parsed.data.SUB2API_API_KEY,
    modelId: parsed.data.SUB2API_MODEL_ID,
    scope: parsed.data.SUB2API_SCOPE,
    credentialVersion: parsed.data.SUB2API_CREDENTIAL_VERSION,
    concurrency: parsed.data.SUB2API_CONCURRENCY,
    maxUnknown: parsed.data.SUB2API_MAX_UNKNOWN,
    dailyBudgetMicros: parsed.data.SUB2API_DAILY_BUDGET_MICROS,
  };
}

export function validateThirdPartyConfig(
  config: ThirdPartyProviderConfig,
  nodeEnv = 'development',
): ThirdPartyProviderConfig {
  if (
    config.id !== 'sub2api' ||
    config.kind !== 'third_party' ||
    !config.apiKey.trim() ||
    /[\r\n]/.test(config.apiKey) ||
    !identifier.safeParse(config.modelId).success ||
    !identifier.safeParse(config.scope).success ||
    !identifier.safeParse(config.credentialVersion).success
  )
    throw invalid();
  if (
    !Number.isInteger(config.concurrency) ||
    config.concurrency < 1 ||
    config.concurrency > 4 ||
    !Number.isInteger(config.maxUnknown) ||
    config.maxUnknown < 1 ||
    config.maxUnknown > 4 ||
    !/^(0|[1-9]\d{0,14})$/.test(config.dailyBudgetMicros)
  )
    throw invalid();
  const baseUrl = normalizeOpenAICompatibleBaseUrl(config.baseUrl, nodeEnv);
  return { ...config, baseUrl };
}

export function loadThirdPartyImageConfig(
  env: Record<string, string | undefined>,
  nodeEnv = env.NODE_ENV ?? 'development',
): ThirdPartyImageConfig | undefined {
  const raw = env.SUB2API_IMAGE_MODELS_JSON;
  if (!raw || raw.trim() === '') return undefined;
  const common = loadThirdPartyConfig(env, nodeEnv);
  if (!common) throw invalid('Sub2API image models require an enabled Sub2API channel');
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw invalid('Invalid SUB2API_IMAGE_MODELS_JSON');
  }
  const parsed = imageSchema.safeParse(decoded);
  if (!parsed.success) throw invalid('Invalid SUB2API_IMAGE_MODELS_JSON');
  const modelIds = parsed.data.models.map((model) => model.modelId);
  if (new Set(modelIds).size !== modelIds.length)
    throw invalid('SUB2API_IMAGE_MODELS_JSON contains duplicate models');
  for (const model of parsed.data.models) {
    const resolutions = officialSpecs(model.modelId).map((spec) => spec.resolution);
    if (
      model.enabledResolutions.some((resolution) => !resolutions.includes(resolution)) ||
      !officialSpecs(model.modelId).some((spec) =>
        model.enabledResolutions.includes(spec.resolution),
      )
    )
      throw invalid('SUB2API_IMAGE_MODELS_JSON contains an unsupported resolution');
  }
  return {
    id: common.id,
    kind: common.kind,
    baseUrl: common.baseUrl,
    apiKey: common.apiKey,
    scope: common.scope,
    credentialVersion: common.credentialVersion,
    concurrency: common.concurrency,
    maxUnknown: common.maxUnknown,
    dailyBudgetMicros: common.dailyBudgetMicros,
    revision: parsed.data.revision,
    models: parsed.data.models,
  };
}

export function validateThirdPartyImageConfig(
  config: ThirdPartyImageConfig,
  nodeEnv = 'development',
): ThirdPartyImageConfig {
  validateThirdPartyConfig({ ...config, modelId: 'gpt-image-2' }, nodeEnv);
  const parsed = imageSchema.safeParse({ revision: config.revision, models: config.models });
  if (!parsed.success) throw invalid('Invalid Sub2API image configuration');
  if (new Set(config.models.map((model) => model.modelId)).size !== config.models.length)
    throw invalid('Sub2API image configuration contains duplicate models');
  for (const model of config.models) {
    const resolutions = officialSpecs(model.modelId).map((spec) => spec.resolution);
    if (model.enabledResolutions.some((resolution) => !resolutions.includes(resolution)))
      throw invalid('Sub2API image configuration contains an unsupported resolution');
    if (BigInt(model.reserveCostMicros) > BigInt(config.dailyBudgetMicros))
      throw invalid('Sub2API image reserve exceeds the configured daily budget');
  }
  return config;
}

export function thirdPartyImageSnapshot(
  config: ThirdPartyImageConfig | undefined,
  modelId: string,
  resolution: string,
  ratio: string,
) {
  const model = config?.models.find((item) => item.modelId === modelId);
  const output = officialSpecs(modelId).find(
    (spec) => spec.resolution === resolution && spec.ratio === ratio,
  );
  if (!config || !model || !output || !model.enabledResolutions.includes(resolution)) return;
  const definition = OFFICIAL_MODELS.find((item) => item.id === modelId);
  // Gate on the protocol the model needs, not on one hard-coded model ID.
  if (!definition || OFFICIAL_PROTOCOLS[definition.provider] !== OFFICIAL_PROTOCOLS.openai) return;
  const revision = createHash('sha256')
    .update(
      JSON.stringify({
        revision: config.revision,
        baseUrl: config.baseUrl,
        scope: config.scope,
        credentialVersion: config.credentialVersion,
        model,
        output,
      }),
    )
    .digest('hex')
    .slice(0, 24);
  return {
    ...output,
    protocol: 'openai-images-third-party-v1',
    channelId: `third-party-${config.id}-${modelId}-${output.id}-${revision}`,
    revision,
    // Safe: the protocol gate above already restricted modelId to a catalog id whose
    // protocol is OpenAI Images, i.e. an OfficialModelId.
    upstreamModelId: modelId as OfficialModelId,
    provider: 'openai' as const,
    credentialVersion: config.credentialVersion,
    pricing: model.pricing,
    reserveCostMicros: model.reserveCostMicros,
  };
}

export function redactThirdPartyConfig(config: ThirdPartyProviderConfig) {
  return {
    id: config.id,
    kind: config.kind,
    baseUrl: config.baseUrl,
    modelId: config.modelId,
    scope: config.scope,
    credentialVersion: config.credentialVersion,
    concurrency: config.concurrency,
    maxUnknown: config.maxUnknown,
    dailyBudgetMicros: config.dailyBudgetMicros,
    credentialConfigured: config.apiKey.length > 0,
  };
}
