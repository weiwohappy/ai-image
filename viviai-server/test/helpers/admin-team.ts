import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestDatabase } from './database.js';
import { adminApp, adminOrigin, fixtureAdmin } from './admin.js';
import type { INestApplication } from '@nestjs/common';

export async function teamFixture(config = {}) {
  const db = await createTestDatabase();
  let application: INestApplication | undefined;
  try {
    const app = (application = await adminApp(db, {
      nodeEnv: 'development',
      host: '127.0.0.1',
      ...config,
    }));
    const superAdmin = await fixtureAdmin(db, ['super_admin']);
    const manager = await fixtureAdmin(db, ['system_admin']);
    const ordinary = await fixtureAdmin(db, ['support']);
    const call = (
      method: 'get' | 'post' | 'patch' | 'put' | 'delete',
      cookie: string,
      path: string,
      body = {},
      key = randomUUID(),
    ) =>
      request(app.getHttpServer())
        [method](`/api/admin${path}`)
        .set('Origin', adminOrigin)
        .set('Cookie', cookie)
        .set('Idempotency-Key', key)
        .send(body);
    return {
      db,
      app,
      superAdmin,
      manager,
      ordinary,
      call,
      post: (cookie: string, path: string, body: object, key = randomUUID()) =>
        call('post', cookie, path, body, key),
      close: async () => {
        await app.close();
        await db.cleanup();
      },
    };
  } catch (error) {
    await application?.close();
    await db.cleanup();
    throw error;
  }
}
