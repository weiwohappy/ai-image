import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import type { ObjectStore } from './object-store.js';

export interface S3ObjectStoreConfig {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
}

export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;

  constructor(private readonly config: S3ObjectStoreConfig, client?: S3Client) {
    if (!config.bucket) throw new Error('S3 bucket is required');
    this.client = client ?? new S3Client(toClientConfig(config));
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    validateObjectKey(key);
    await this.client.send(new PutObjectCommand({ Bucket: this.config.bucket, Key: key, Body: bytes, ContentLength: bytes.byteLength, ContentType: contentType }));
  }

  async get(key: string): Promise<Uint8Array> {
    validateObjectKey(key);
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key }));
    if (!result.Body) throw new Error('S3 object has no body');
    return new Uint8Array(await result.Body.transformToByteArray());
  }

  async delete(key: string): Promise<void> {
    validateObjectKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }));
  }
}

function toClientConfig(config: S3ObjectStoreConfig): S3ClientConfig {
  const credentials = config.accessKeyId && config.secretAccessKey
    ? { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }
    : undefined;
  return {
    region: config.region,
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    ...(credentials === undefined ? {} : { credentials }),
    ...(config.forcePathStyle === undefined ? {} : { forcePathStyle: config.forcePathStyle }),
  };
}

function validateObjectKey(key: string): void {
  if (key.length === 0 || key.startsWith('/') || key.includes('\\') || key.includes('\0') || key.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('Invalid object key');
  }
}
