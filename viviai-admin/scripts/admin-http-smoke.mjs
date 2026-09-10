import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AdminClient } from '../src/http.ts';
import { createTestDatabase } from '../../viviai-server/test/helpers/database.ts';
import { createTestStorage } from '../../viviai-server/test/helpers/storage.ts';
import {
  adminApp,
  adminOrigin,
  currentCode,
  fixtureJob,
} from '../../viviai-server/test/helpers/admin.ts';
import { bootstrapAdministrators } from '../../viviai-server/src/modules/admin/bootstrap.ts';

// Actual HTTP + the production frontend parser. The cookie jar exists only here,
// standing in for browser-managed HttpOnly cookies; it never enters the app bundle.
const nativeFetch = globalThis.fetch;
const jar = new Map();
let db;
let storage;
let app;
try {
  db = await createTestDatabase();
  storage = await createTestStorage();
  app = await adminApp(db, {
    localStorageRoot: storage.root,
    devMailboxRoot: `${storage.root}/mail`,
    queueNamespace: `admin-smoke-${randomUUID()}`,
  });
  const address = app.getHttpServer().address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  globalThis.fetch = async (path, options = {}) => {
    assert.equal(typeof path, 'string');
    assert(path.startsWith('/api/admin/'), 'smoke cannot call a model/payment or other service');
    const headers = new Headers(options.headers);
    headers.set('Origin', adminOrigin);
    if (jar.size)
      headers.set('Cookie', [...jar].map(([key, value]) => `${key}=${value}`).join('; '));
    const response = await nativeFetch(`${origin}${path}`, { ...options, headers });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0];
      const split = pair.indexOf('=');
      const key = pair.slice(0, split);
      const value = pair.slice(split + 1);
      if (value) jar.set(key, value);
      else jar.delete(key);
    }
    return response;
  };
  const client = new AdminClient();
  assert.equal((await client.get('/status')).enabled, true);
  const invitations = await bootstrapAdministrators(db.database, [
    { email: 'first@example.test', roles: ['owner'], extraPermissions: ['sensitive.read'] },
    { email: 'second@example.test', roles: ['system_admin'] },
  ]);
  const enrollment = await client.post(
    '/auth/invitations/accept',
    {
      token: invitations[0].token,
      email: invitations[0].email,
      displayName: 'Smoke fixture',
      password: 'test-only-secure-password-123',
    },
    undefined,
    false,
  );
  assert.equal(enrollment.next, 'enroll');
  await assert.rejects(client.get('/me'), (error) => error.status === 401);
  const verified = await client.post(
    '/auth/mfa/verify',
    { method: 'totp', code: currentCode(enrollment.secret) },
    undefined,
    false,
  );
  assert.equal(verified.recoveryCodes.length, 8);
  const actor = await client.get('/me');
  assert.equal(actor.email, invitations[0].email);
  const boundAccount = await db.database.client.adminAccount.findUniqueOrThrow({
    where: { id: actor.id },
    include: { roleBindings: true },
  });
  assert.deepEqual(
    boundAccount.roleBindings.map((binding) => binding.roleKey),
    ['owner'],
  );
  assert.deepEqual(actor.roles, ['owner']);
  assert(actor.permissions.includes('sensitive.read'));
  assert.equal((await client.get('/models')).rows.length, 5);
  const model = await client.get('/models/gemini-3.1-flash-lite-image');
  assert(
    model.tables.some((table) =>
      table.rows.some((row) => typeof row.width === 'number' && typeof row.height === 'number'),
    ),
  );
  const job = await fixtureJob(db);
  const bytes = Buffer.from([137, 80, 78, 71]);
  const asset = await db.database.client.asset.create({
    data: {
      userId: job.userId,
      name: 'isolated-fixture',
      objectKey: 'smoke/private.png',
      width: 12,
      height: 13,
      byteSize: bytes.length,
      contentType: 'image/png',
    },
  });
  await db.database.client.assetPin.create({
    data: { jobId: job.id, assetId: asset.id, role: 'reference', snapshot: {} },
  });
  await storage.store.put('smoke/private.png', bytes, 'image/png');
  const jobs = await client.get(`/jobs?q=${job.id}`);
  assert.equal(jobs.rows[0].id, job.id);
  const detail = await client.get(`/jobs/${job.id}`);
  assert(!JSON.stringify(detail).includes('customer-private-prompt'));
  assert.equal(detail.sensitive.jobId, job.id);
  const grant = await client.post('/sensitive-access-grants', {
    jobId: job.id,
    reason: '核查隔离测试工单 CASE-123 的参考素材',
  });
  const sensitive = await client.get(`/jobs/${job.id}/sensitive?grantId=${grant.id}`);
  assert.equal(sensitive.prompt, 'customer-private-prompt');
  const image = await client.blob(`/assets/${asset.id}/preview?grantId=${grant.id}`);
  assert.equal(image.type, 'image/png');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes);
  await db.database.client.adminSensitiveGrant.update({
    where: { id: grant.id },
    data: { expiresAt: new Date(Date.now() - 1) },
  });
  await assert.rejects(client.blob(`/assets/${asset.id}/preview?grantId=${grant.id}`), (error) =>
    [403, 404].includes(error.status),
  );
  assert.equal((await client.post('/auth/logout', {}, undefined, false)).success, true);
  await assert.rejects(client.get('/me'), (error) => error.status === 401);
  assert.equal(jar.size, 0);
  console.info(
    'Admin HTTP smoke passed: invite → MFA → me → model matrix → task → private preview → expiry → logout. Isolated fixtures only.',
  );
} finally {
  globalThis.fetch = nativeFetch;
  jar.clear();
  await app?.close();
  await db?.cleanup();
  await storage?.cleanup();
}
