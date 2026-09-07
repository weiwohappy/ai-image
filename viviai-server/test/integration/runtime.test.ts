import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createApp } from '../../src/main.js';
import { createTestApp } from '../helpers/app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';
import { createTestStorage } from '../helpers/storage.js';

describe('runtime integration', () => {
  let testDatabase: TestDatabase;

  beforeAll(async () => {
    testDatabase = await createTestDatabase();
  });

  afterAll(async () => {
    await testDatabase?.cleanup();
  });

  it('returns the public health envelope with a request ID', async () => {
    const app = await createTestApp(testDatabase.url);

    try {
      const response = await request(app.getHttpServer()).get('/api/health').expect(200);

      expect(response.body).toMatchObject({
        data: { status: 'ok' },
        message: 'ok',
        requestId: expect.any(String),
      });
    } finally {
      await app.close();
    }
  });

  it('reports ready when the injected database is reachable', async () => {
    const app = await createTestApp(testDatabase.url);

    try {
      const response = await request(app.getHttpServer()).get('/api/health/ready').expect(200);

      expect(response.body).toMatchObject({
        data: { status: 'ready' },
        message: 'ok',
        requestId: expect.any(String),
      });
    } finally {
      await app.close();
    }
  });

  it('reports a frontend-compatible error code when the database is unreachable', async () => {
    const unavailableUrl = new URL(testDatabase.url);
    unavailableUrl.port = '1';
    const app = await createApp({ databaseUrl: unavailableUrl.toString() });

    try {
      const response = await request(app.getHttpServer()).get('/api/health/ready').expect(503);

      expect(response.body).toMatchObject({
        data: null,
        message: 'Database is unavailable',
        requestId: expect.any(String),
        code: 'DATABASE_UNAVAILABLE',
      });
    } finally {
      await app.close();
    }
  });

  it('rejects unsafe production overrides through the application factory', async () => {
    let app: Awaited<ReturnType<typeof createApp>> | undefined;
    let caught: unknown;

    try {
      app = await createApp({
        nodeEnv: 'production',
        storageDriver: 'local',
        simulationProviderEnabled: true,
        devMailEnabled: true,
      });
    } catch (error) {
      caught = error;
    } finally {
      await app?.close();
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/simulation.*local storage.*development mail/i);
  });

  it('rejects invalid general overrides through the application factory', async () => {
    let app: Awaited<ReturnType<typeof createApp>> | undefined;
    let caught: unknown;

    try {
      app = await createApp({ corsOrigins: ['*'] });
    } catch (error) {
      caught = error;
    } finally {
      await app?.close();
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/CORS origins.*explicit/i);
  });

  it('rejects partial static S3 credentials', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'test',
        DATABASE_URL: testDatabase.url,
        REDIS_URL: 'redis://127.0.0.1:56379',
        CORS_ORIGINS: 'http://127.0.0.1:3000',
        STORAGE_DRIVER: 's3',
        S3_BUCKET: 'private-assets',
        S3_REGION: 'us-east-1',
        S3_ACCESS_KEY_ID: 'access',
        S3_SECRET_ACCESS_KEY: undefined,
        SIMULATION_PROVIDER_ENABLED: 'true',
        DEV_MAIL_ENABLED: 'true',
      }),
    ).toThrow(/both.*credential/i);
  });

  it('rejects development-only providers, storage and mail in production', () => {
    const productionBase = {
      NODE_ENV: 'production',
      DATABASE_URL: testDatabase.url,
      REDIS_URL: 'redis://127.0.0.1:56379',
      CORS_ORIGINS: 'https://app.viviai.example',
      STORAGE_DRIVER: 's3',
      S3_BUCKET: 'private-assets',
      S3_REGION: 'us-east-1',
      S3_ENDPOINT: 'https://s3.example.com',
      S3_ACCESS_KEY_ID: 'access',
      S3_SECRET_ACCESS_KEY: 'secret',
      SIMULATION_PROVIDER_ENABLED: 'false',
      DEV_MAIL_ENABLED: 'false',
    };

    expect(() => loadConfig({ ...productionBase, SIMULATION_PROVIDER_ENABLED: 'true' })).toThrow(
      /simulation/i,
    );
    expect(() => loadConfig({ ...productionBase, STORAGE_DRIVER: 'local' })).toThrow(/local/i);
    expect(() => loadConfig({ ...productionBase, DEV_MAIL_ENABLED: 'true' })).toThrow(/mail/i);
  });

  it('roundtrips private local objects and refuses path traversal', async () => {
    const storage = await createTestStorage();
    const { root, store } = storage;

    try {
      await expect(store.put('../outside', new Uint8Array([1]), 'image/png')).rejects.toThrow();
      await expect(store.put('/absolute', new Uint8Array([1]), 'image/png')).rejects.toThrow();

      await store.put('test/image.png', new Uint8Array([1, 2, 3]), 'image/png');
      expect(await store.get('test/image.png')).toEqual(new Uint8Array([1, 2, 3]));
      expect(await readFile(join(root, 'test/image.png'))).toEqual(Buffer.from([1, 2, 3]));

      await store.delete('test/image.png');
      await expect(store.get('test/image.png')).rejects.toThrow();
    } finally {
      await storage.cleanup();
    }
  });

  it('persists concurrent objects that create the same new parent', async () => {
    const storage = await createTestStorage();

    try {
      await Promise.all([
        storage.store.put('shared/first.png', new Uint8Array([1]), 'image/png'),
        storage.store.put('shared/second.png', new Uint8Array([2]), 'image/png'),
      ]);

      expect(await storage.store.get('shared/first.png')).toEqual(new Uint8Array([1]));
      expect(await storage.store.get('shared/second.png')).toEqual(new Uint8Array([2]));
    } finally {
      await storage.cleanup();
    }
  });

  it('applies migrations to a unique real PostgreSQL test schema', async () => {
    const row = await testDatabase.database.client.healthProbe.create({ data: {} });
    const count = await testDatabase.database.client.healthProbe.count();

    expect(row.id).toEqual(expect.any(String));
    expect(count).toBeGreaterThanOrEqual(1);
    expect(new URL(testDatabase.url).searchParams.get('schema')).toMatch(/^viviai_test_[a-f0-9]+$/);
  });
});
