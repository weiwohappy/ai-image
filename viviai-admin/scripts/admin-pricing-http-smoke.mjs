import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AdminClient } from '../src/http.ts';
import { createTestDatabase } from '../../viviai-server/test/helpers/database.ts';
import { adminApp, adminOrigin, fixtureAdmin } from '../../viviai-server/test/helpers/admin.ts';

// Exercise the production frontend transport against real HTTP and an owned test schema.
// This script never writes live prices or calls a model provider.
const nativeFetch = globalThis.fetch;
let db,
  app,
  cookie = '';
const statusIs = (status) => (error) => error.status === status;
try {
  db = await createTestDatabase();
  app = await adminApp(db, {
    nodeEnv: 'development',
    host: '127.0.0.1',
    queueNamespace: `pricing-http-smoke-${randomUUID()}`,
  });
  const address = app.getHttpServer().address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  globalThis.fetch = async (path, options = {}) => {
    assert(
      typeof path === 'string' && path.startsWith('/api/admin/'),
      'Only local admin requests are permitted',
    );
    const headers = new Headers(options.headers);
    headers.set('Origin', adminOrigin);
    if (cookie) headers.set('Cookie', cookie);
    return nativeFetch(`${origin}${path}`, { ...options, headers });
  };
  const superAdmin = await fixtureAdmin(db, ['super_admin']);
  const reader = await fixtureAdmin(db, ['model_operator']);
  const client = new AdminClient();
  cookie = superAdmin.cookie;
  assert.equal((await client.get('/status')).modelPricingWritesEnabled, true);
  assert((await client.get('/me')).permissions.includes('model-pricing.write'));
  const path = '/model-pricing/gpt-image-2/1K';
  const initial = await client.get(path);
  assert.equal(initial.priceId, null);
  assert.equal(initial.version, 0);
  assert.equal(initial.runtimeAvailable, false);
  assert(initial.specs.length > 0);
  const body = {
    unitCredits: 120,
    enabled: true,
    expectedVersion: 0,
    reason: '隔离测试模型分辨率积分定价',
  };
  const key = randomUUID();
  const saved = await client.command('PUT', path, body, key);
  assert.equal(saved.version, 1);
  assert.deepEqual(await client.command('PUT', path, body, key), saved);
  await assert.rejects(
    client.command('PUT', path, { ...body, unitCredits: 121 }, key),
    statusIs(409),
  );
  const list = await client.get('/model-pricing?modelId=gpt-image-2');
  const row = list.items.find((item) => item.resolution === '1K');
  assert.equal(list.writeEnabled, true);
  assert.equal(row.unitCredits, 120);
  assert.equal(row.availabilityReason, 'runtime_unavailable');
  assert.equal(row.runtimeAvailable, false);
  const noOp = await client.command('PUT', path, { ...body, expectedVersion: 1 }, randomUUID());
  assert.equal(noOp.version, 1);
  const disabled = await client.command(
    'PUT',
    path,
    { ...body, enabled: false, expectedVersion: 1 },
    randomUUID(),
  );
  assert.equal(disabled.version, 2);
  await assert.rejects(
    client.command('PUT', path, { ...body, expectedVersion: 1 }, randomUUID()),
    statusIs(409),
  );
  const enabled = await client.command('PUT', path, { ...body, expectedVersion: 2 }, randomUUID());
  assert.equal(enabled.version, 3);
  const historyPath = '/model-pricing/gpt-image-2/history?resolution=1K&limit=1';
  const history = await client.get(historyPath);
  assert.equal(history.items.length, 1);
  assert.deepEqual(history.items[0].after, { unitCredits: 120, enabled: true, version: 3 });
  assert(history.nextCursor);
  const older = await client.get(`${historyPath}&cursor=${encodeURIComponent(history.nextCursor)}`);
  assert.notEqual(older.items[0].id, history.items[0].id);
  assert.equal(older.items[0].after.enabled, false);
  cookie = reader.cookie;
  const readonly = await client.get(path);
  assert(readonly.allowedActions.every((action) => !action.allowed));
  await assert.rejects(
    client.command('PUT', path, { ...body, expectedVersion: 3 }, randomUUID()),
    statusIs(403),
  );
  cookie = superAdmin.cookie;
  for (const bad of [0, -1, 1.5, 1_000_001, '120']) {
    await assert.rejects(
      client.command('PUT', path, { ...body, unitCredits: bad, expectedVersion: 3 }, randomUUID()),
      statusIs(400),
    );
  }
  assert.equal((await client.get(path)).version, 3);
  await client.post('/auth/logout', {}, undefined, false);
  await assert.rejects(client.get('/me'), statusIs(401));
  console.info(
    'Pricing HTTP smoke passed: real AdminClient, create/edit-state/replay/conflicts/no-op/history/paging/permissions/validation; no API keys or public pricing fixtures.',
  );
} finally {
  globalThis.fetch = nativeFetch;
  cookie = '';
  try {
    await app?.close();
  } finally {
    await db?.cleanup();
  }
}
