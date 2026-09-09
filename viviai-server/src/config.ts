import { z } from 'zod';
import { loadAdminConfig, validateAdminConfig, type AdminConfig } from './modules/admin/config.js';
import {
  loadOfficialConfig,
  validateOfficialConfig,
  type OfficialConfig,
} from './modules/providers/official-config.js';

export type NodeEnvironment = 'development' | 'test' | 'production';
export type StorageDriver = 'local' | 's3';

export interface AppConfig {
  admin?: AdminConfig;
  officialImages?: OfficialConfig;
  nodeEnv: NodeEnvironment;
  host: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  queueNamespace: string;
  corsOrigins: string[];
  jsonBodyLimit: string;
  formBodyLimit: string;
  storageDriver: StorageDriver;
  localStorageRoot: string;
  simulationProviderEnabled: boolean;
  devMailEnabled: boolean;
  devMailboxRoot: string;
  smtpUrl?: string;
  mailFrom?: string;
  s3Bucket?: string;
  s3Region?: string;
  s3Endpoint?: string;
  s3AccessKeyId?: string;
  s3SecretAccessKey?: string;
  s3ForcePathStyle: boolean;
}

const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');
const url = z.string().url();

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
    DATABASE_URL: url.refine((value) => /^postgres(ql)?:/.test(value), 'must be a PostgreSQL URL'),
    REDIS_URL: url.refine((value) => value.startsWith('redis:'), 'must be a Redis URL'),
    QUEUE_NAMESPACE: z
      .string()
      .regex(/^[a-z0-9-]{3,80}$/)
      .default('development'),
    CORS_ORIGINS: z.string().min(1).default('http://127.0.0.1:3000,http://localhost:3000'),
    JSON_BODY_LIMIT: z.string().min(1).default('1mb'),
    FORM_BODY_LIMIT: z.string().min(1).default('1mb'),
    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    LOCAL_STORAGE_ROOT: z.string().min(1).default('.data/private'),
    SIMULATION_PROVIDER_ENABLED: booleanString.default(true),
    DEV_MAIL_ENABLED: booleanString.default(true),
    DEV_MAILBOX_ROOT: z.string().min(1).default('.data/mailbox'),
    SMTP_URL: z.string().url().optional(),
    MAIL_FROM: z.string().email().optional(),
    S3_BUCKET: z.string().min(1).optional(),
    S3_REGION: z.string().min(1).optional(),
    S3_ENDPOINT: url.optional(),
    S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    S3_FORCE_PATH_STYLE: booleanString.default(false),
  })
  .superRefine((value, context) => {
    const origins = value.CORS_ORIGINS.split(',').map((origin) => origin.trim());
    if (origins.some((origin) => origin === '*' || !isHttpOrigin(origin))) {
      context.addIssue({
        code: 'custom',
        path: ['CORS_ORIGINS'],
        message: 'must contain explicit HTTP(S) origins and cannot contain *',
      });
    }

    if (value.STORAGE_DRIVER === 's3') {
      for (const field of ['S3_BUCKET', 'S3_REGION'] as const) {
        if (!value[field]) {
          context.addIssue({
            code: 'custom',
            path: [field],
            message: 'is required for S3 storage',
          });
        }
      }
    }

    if (value.NODE_ENV === 'production') {
      if (value.SIMULATION_PROVIDER_ENABLED) {
        context.addIssue({
          code: 'custom',
          path: ['SIMULATION_PROVIDER_ENABLED'],
          message: 'simulation providers are forbidden in production',
        });
      }
      if (value.STORAGE_DRIVER === 'local') {
        context.addIssue({
          code: 'custom',
          path: ['STORAGE_DRIVER'],
          message: 'local storage is forbidden in production',
        });
      }
      if (value.DEV_MAIL_ENABLED) {
        context.addIssue({
          code: 'custom',
          path: ['DEV_MAIL_ENABLED'],
          message: 'development mail is forbidden in production',
        });
      }
    }
  });

function isHttpOrigin(value: string): boolean {
  try {
    const origin = new URL(value);
    return (origin.protocol === 'http:' || origin.protocol === 'https:') && origin.origin === value;
  } catch {
    return false;
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = environmentSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'environment'} ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }

  const value = parsed.data;
  return validateConfig({
    admin: loadAdminConfig(env),
    officialImages: loadOfficialConfig(env),
    nodeEnv: value.NODE_ENV,
    host: value.HOST,
    port: value.PORT,
    databaseUrl: value.DATABASE_URL,
    redisUrl: value.REDIS_URL,
    queueNamespace: value.QUEUE_NAMESPACE,
    corsOrigins: value.CORS_ORIGINS.split(',').map((origin) => origin.trim()),
    jsonBodyLimit: value.JSON_BODY_LIMIT,
    formBodyLimit: value.FORM_BODY_LIMIT,
    storageDriver: value.STORAGE_DRIVER,
    localStorageRoot: value.LOCAL_STORAGE_ROOT,
    simulationProviderEnabled: value.SIMULATION_PROVIDER_ENABLED,
    devMailEnabled: value.DEV_MAIL_ENABLED,
    devMailboxRoot: value.DEV_MAILBOX_ROOT,
    ...(value.SMTP_URL === undefined ? {} : { smtpUrl: value.SMTP_URL }),
    ...(value.MAIL_FROM === undefined ? {} : { mailFrom: value.MAIL_FROM }),
    ...(value.S3_BUCKET === undefined ? {} : { s3Bucket: value.S3_BUCKET }),
    ...(value.S3_REGION === undefined ? {} : { s3Region: value.S3_REGION }),
    ...(value.S3_ENDPOINT === undefined ? {} : { s3Endpoint: value.S3_ENDPOINT }),
    ...(value.S3_ACCESS_KEY_ID === undefined ? {} : { s3AccessKeyId: value.S3_ACCESS_KEY_ID }),
    ...(value.S3_SECRET_ACCESS_KEY === undefined
      ? {}
      : { s3SecretAccessKey: value.S3_SECRET_ACCESS_KEY }),
    s3ForcePathStyle: value.S3_FORCE_PATH_STYLE,
  });
}

export function validateConfig(config: AppConfig): AppConfig {
  validateAdminConfig(config.admin, config.nodeEnv);
  if (config.officialImages) validateOfficialConfig(config.officialImages);
  const issues: string[] = [];
  const hasAccessKey = config.s3AccessKeyId !== undefined;
  const hasSecretKey = config.s3SecretAccessKey !== undefined;

  if (!['development', 'test', 'production'].includes(config.nodeEnv)) {
    issues.push('node environment is invalid');
  }
  if (typeof config.host !== 'string' || config.host.length === 0) {
    issues.push('host is required');
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65_535) {
    issues.push('port must be an integer from 1 to 65535');
  }
  if (!hasUrlProtocol(config.databaseUrl, ['postgres:', 'postgresql:'])) {
    issues.push('database URL must be a PostgreSQL URL');
  }
  if (!hasUrlProtocol(config.redisUrl, ['redis:', 'rediss:'])) {
    issues.push('Redis URL must be a Redis URL');
  }
  if (!/^[a-z0-9-]{3,80}$/.test(config.queueNamespace)) issues.push('queue namespace is invalid');
  if (
    !Array.isArray(config.corsOrigins) ||
    config.corsOrigins.length === 0 ||
    config.corsOrigins.some((origin) => origin === '*' || !isHttpOrigin(origin))
  ) {
    issues.push('CORS origins must be explicit HTTP(S) origins');
  }
  if (typeof config.jsonBodyLimit !== 'string' || config.jsonBodyLimit.length === 0) {
    issues.push('JSON body limit is required');
  }
  if (typeof config.formBodyLimit !== 'string' || config.formBodyLimit.length === 0) {
    issues.push('form body limit is required');
  }
  if (!['local', 's3'].includes(config.storageDriver)) {
    issues.push('storage driver is invalid');
  }
  if (typeof config.localStorageRoot !== 'string' || config.localStorageRoot.length === 0) {
    issues.push('local storage root is required');
  }
  if (
    typeof config.simulationProviderEnabled !== 'boolean' ||
    typeof config.devMailEnabled !== 'boolean' ||
    typeof config.s3ForcePathStyle !== 'boolean'
  ) {
    issues.push('boolean configuration flags are invalid');
  }
  if (config.s3Endpoint !== undefined && !hasUrlProtocol(config.s3Endpoint, ['http:', 'https:'])) {
    issues.push('S3 endpoint must be an HTTP(S) URL');
  }
  if (hasAccessKey !== hasSecretKey) {
    issues.push('S3 must provide both credential fields or neither');
  }
  if (config.storageDriver === 's3') {
    if (!config.s3Bucket) issues.push('S3 bucket is required for S3 storage');
    if (!config.s3Region) issues.push('S3 region is required for S3 storage');
  }
  if (config.nodeEnv === 'production') {
    if (config.simulationProviderEnabled) {
      issues.push('simulation providers are forbidden in production');
    }
    if (config.storageDriver === 'local') {
      issues.push('local storage is forbidden in production');
    }
    if (config.devMailEnabled) {
      issues.push('development mail is forbidden in production');
    }
    if (!config.smtpUrl || !config.mailFrom)
      issues.push('SMTP and mail sender are required in production');
  }
  if (!config.devMailboxRoot) issues.push('development mailbox root is required');
  if (config.smtpUrl && !hasUrlProtocol(config.smtpUrl, ['smtp:', 'smtps:']))
    issues.push('SMTP URL is invalid');
  if (config.mailFrom && !z.string().email().safeParse(config.mailFrom).success)
    issues.push('mail sender is invalid');
  if (issues.length > 0) {
    throw new Error(`Invalid configuration: ${issues.join('; ')}`);
  }
  return config;
}

function hasUrlProtocol(value: unknown, protocols: string[]): boolean {
  if (typeof value !== 'string') return false;
  try {
    return protocols.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
