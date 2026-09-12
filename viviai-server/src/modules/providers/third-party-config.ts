import { z } from 'zod';

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
