import { z } from 'zod';

export type NodeEnvironment = 'development' | 'test' | 'production';
export type StorageDriver = 'local' | 's3';

export interface AppConfig {
  nodeEnv: NodeEnvironment;
  host: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  corsOrigins: string[];
  jsonBodyLimit: string;
  formBodyLimit: string;
  storageDriver: StorageDriver;
  localStorageRoot: string;
  simulationProviderEnabled: boolean;
  devMailEnabled: boolean;
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
    CORS_ORIGINS: z.string().min(1).default('http://127.0.0.1:3000,http://localhost:3000'),
    JSON_BODY_LIMIT: z.string().min(1).default('1mb'),
    FORM_BODY_LIMIT: z.string().min(1).default('1mb'),
    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    LOCAL_STORAGE_ROOT: z.string().min(1).default('.data/private'),
    SIMULATION_PROVIDER_ENABLED: booleanString.default(true),
    DEV_MAIL_ENABLED: booleanString.default(true),
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
          context.addIssue({ code: 'custom', path: [field], message: 'is required for S3 storage' });
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
  return {
    nodeEnv: value.NODE_ENV,
    host: value.HOST,
    port: value.PORT,
    databaseUrl: value.DATABASE_URL,
    redisUrl: value.REDIS_URL,
    corsOrigins: value.CORS_ORIGINS.split(',').map((origin) => origin.trim()),
    jsonBodyLimit: value.JSON_BODY_LIMIT,
    formBodyLimit: value.FORM_BODY_LIMIT,
    storageDriver: value.STORAGE_DRIVER,
    localStorageRoot: value.LOCAL_STORAGE_ROOT,
    simulationProviderEnabled: value.SIMULATION_PROVIDER_ENABLED,
    devMailEnabled: value.DEV_MAIL_ENABLED,
    ...(value.S3_BUCKET === undefined ? {} : { s3Bucket: value.S3_BUCKET }),
    ...(value.S3_REGION === undefined ? {} : { s3Region: value.S3_REGION }),
    ...(value.S3_ENDPOINT === undefined ? {} : { s3Endpoint: value.S3_ENDPOINT }),
    ...(value.S3_ACCESS_KEY_ID === undefined ? {} : { s3AccessKeyId: value.S3_ACCESS_KEY_ID }),
    ...(value.S3_SECRET_ACCESS_KEY === undefined
      ? {}
      : { s3SecretAccessKey: value.S3_SECRET_ACCESS_KEY }),
    s3ForcePathStyle: value.S3_FORCE_PATH_STYLE,
  };
}
