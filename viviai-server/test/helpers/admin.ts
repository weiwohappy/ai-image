import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/main.js';
import {
  digest,
  encryptSecret,
  hashPassword,
  token,
  totp,
} from '../../src/modules/admin/crypto.js';
import type { TestDatabase } from './database.js';
export const adminKey = Buffer.alloc(32, 12).toString('base64');
export const adminOrigin = 'http://localhost:3010';
export const testSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
export const adminConfig = { enabled: true, origins: [adminOrigin], encryptionKey: adminKey };
export async function adminApp(db: TestDatabase, extra = {}) {
  const app = await createApp({ databaseUrl: db.url, nodeEnv: 'test', admin: adminConfig, ...extra });
  // Own one listener for concurrent requests; Supertest's per-request auto-close can race.
  await app.listen(0, '127.0.0.1');
  return app;
}
export function cookies(response: { headers: Record<string, unknown> }) {
  return ((response.headers['set-cookie'] as string[]) ?? [])
    .map((c) => c.split(';')[0])
    .join('; ');
}
export function currentCode(secret = testSecret, offset = 0) {
  return totp(secret, Math.floor(Date.now() / 30000) + offset);
}
export async function fixtureAdmin(
  db: TestDatabase,
  roles = ['owner'],
  extraPermissions: string[] = [],
) {
  const id = randomUUID();
  const raw = token();
  const account = await db.database.client.adminAccount.create({
    data: {
      id,
      email: `${id}@example.test`,
      displayName: 'Test operator',
      roles,
      extraPermissions,
      status: 'active',
      passwordHash: await hashPassword('test-only-long-password'),
      encryptedMfaSecret: encryptSecret(testSecret, adminKey, id),
    },
  });
  const session = await db.database.client.adminSession.create({
    data: {
      accountId: id,
      tokenHash: digest(raw),
      authVersion: 1,
      expiresAt: new Date(Date.now() + 8 * 3600000),
    },
  });
  return { account, session, cookie: `viviai_admin_session=${raw}` };
}
export async function fixtureJob(db: TestDatabase) {
  const user = await db.database.client.user.create({
    data: {
      email: `${randomUUID()}@example.test`,
      username: randomUUID(),
      passwordHash: 'private-hash',
    },
  });
  const input = {
    source: 'create',
    modelId: 'simulation-image-v1',
    prompt: 'customer-private-prompt',
    resolution: '1K',
    ratio: '1:1',
    count: 1,
  };
  const quote = await db.database.client.generationQuote.create({
    data: {
      userId: user.id,
      input,
      inputHash: 'test',
      productVersion: 'simulation-image-v1',
      unitCredits: 30n,
      totalCredits: 30n,
      expiresAt: new Date(Date.now() + 60000),
    },
  });
  return db.database.client.generationJob.create({
    data: {
      userId: user.id,
      quoteId: quote.id,
      operation: 'create',
      idempotencyKey: randomUUID(),
      requestHash: 'private-request-hash',
      input,
      queueDeadlineAt: new Date(Date.now() + 60000),
      deliveryDeadlineAt: new Date(Date.now() + 120000),
      items: { create: { ordinal: 0, unitCredits: 30n } },
    },
    include: { items: true },
  });
}
