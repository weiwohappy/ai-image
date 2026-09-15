import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { teamFixture } from './helpers/admin-team.js';
import request from 'supertest';
import { adminApp, adminOrigin, fixtureAdmin } from './helpers/admin.js';
import { AdminAuditService } from '../src/modules/admin/audit.service.js';
import { ROLE_PERMISSIONS, validPermissionSet } from '../src/modules/admin/permission-catalog.js';
import { vi } from 'vitest';
import { AdminAuthService } from '../src/modules/admin/auth.service.js';
import { AdminModelPricingService } from '../src/modules/admin/model-pricing/service.js';
import { loadThirdPartyImageConfig } from '../src/modules/providers/third-party-config.js';
import { OPENAI_IMAGES_MODEL_IDS } from '../src/modules/providers/official-models.js';
import pg from 'pg';

describe('admin model credit prices', () => {
  let f: Awaited<ReturnType<typeof teamFixture>>;
  beforeAll(async () => {
    f = await teamFixture();
  });
  afterAll(async () => {
    await f?.close();
  });
  const path = '/model-pricing/gpt-image-2/1K';
  const body = { unitCredits: 120, enabled: true, expectedVersion: 0, reason: '测试模型积分定价' };
  it('lists unpriced reviewed resolutions without credentials and persists the first version', async () => {
    const before = await f.call('get', f.superAdmin.cookie, path);
    expect(before.status).toBe(200);
    expect(before.body.data).toMatchObject({
      priceId: null,
      unitCredits: null,
      version: 0,
      runtimeAvailable: false,
    });
    const saved = await f.call('put', f.superAdmin.cookie, path, body, randomUUID());
    expect(saved.status).toBe(200);
    expect(saved.body.data.version).toBe(1);
    const after = await f.call('get', f.superAdmin.cookie, path);
    expect(after.body.data).toMatchObject({
      unitCredits: 120,
      enabled: true,
      version: 1,
      availabilityReason: 'runtime_unavailable',
    });
  });
  it('denies an administrator without pricing permission', async () => {
    expect((await f.call('put', f.manager.cookie, path, body)).status).toBe(403);
  });
  it('replays once, keeps no-op versions, conflicts on changed payload and records safe history', async () => {
    const key = randomUUID();
    const command = { ...body, expectedVersion: 1, unitCredits: 150 };
    const first = await f.call('put', f.superAdmin.cookie, path, command, key);
    expect(first.body.data.version).toBe(2);
    expect((await f.call('put', f.superAdmin.cookie, path, command, key)).body.data).toEqual(
      first.body.data,
    );
    expect(
      (await f.call('put', f.superAdmin.cookie, path, { ...command, unitCredits: 160 }, key))
        .status,
    ).toBe(409);
    expect(
      (await f.call('put', f.superAdmin.cookie, path, { ...command, expectedVersion: 2 })).body.data
        .version,
    ).toBe(2);
    const history = await f.call(
      'get',
      f.superAdmin.cookie,
      '/model-pricing/gpt-image-2/history?resolution=1K&limit=2',
    );
    expect(history.status).toBe(200);
    expect(history.body.data.items).toHaveLength(2);
    expect(history.body.data.items[0]).toMatchObject({
      before: { unitCredits: 150, enabled: true, version: 2 },
      after: { unitCredits: 150, enabled: true, version: 2 },
    });
    expect(JSON.stringify(history.body.data)).not.toContain(command.reason);
    const cursor = history.body.data.nextCursor;
    const next = await f.call(
      'get',
      f.superAdmin.cookie,
      `/model-pricing/gpt-image-2/history?resolution=1K&limit=2&cursor=${cursor}`,
    );
    expect(next.body.data.items).toHaveLength(1);
    expect(next.body.data.items[0].before).toBeNull();
    expect(
      (
        await f.call(
          'get',
          f.superAdmin.cookie,
          `/model-pricing/gpt-image-2/history?resolution=2K&cursor=${cursor}`,
        )
      ).status,
    ).toBe(400);
    await expect(
      f.db.database.client.adminAuditEvent.delete({ where: { id: history.body.data.items[0].id } }),
    ).rejects.toThrow();
  });
  it('validates numeric ranges, exact tuples, queries, reason and idempotency key', async () => {
    for (const unitCredits of [0, -1, 1.5, 1000001, '100', null])
      expect(
        (await f.call('put', f.superAdmin.cookie, path, { ...body, unitCredits })).status,
      ).toBe(400);
    for (const invalid of [
      { ...body, expectedVersion: -1 },
      { ...body, expectedVersion: '0' },
      { ...body, reason: '短' },
      { ...body, ratio: '1:1' },
      { ...body, enabled: 'true' },
    ])
      expect((await f.call('put', f.superAdmin.cookie, path, invalid)).status).toBe(400);
    expect(
      (
        await request(f.app.getHttpServer())
          .put(`/api/admin${path}`)
          .set('Origin', adminOrigin)
          .set('Cookie', f.superAdmin.cookie)
          .set('Idempotency-Key', 'invalid')
          .send(body)
      ).status,
    ).toBe(400);
    for (const p of ['/model-pricing/no-model/1K', '/model-pricing/gemini-2.5-flash-image/4K'])
      expect((await f.call('put', f.superAdmin.cookie, p, body)).status).toBe(400);
    for (const p of [
      '/model-pricing?extra=true',
      '/model-pricing?modelId=no-model',
      '/model-pricing/gpt-image-2/history?limit=101',
      '/model-pricing/gpt-image-2/history?cursor=bad',
      `${path}?extra=1`,
    ])
      expect((await f.call('get', f.superAdmin.cookie, p)).status).toBe(400);
  });
  it('serializes distinct concurrent first creates and rolls back price when audit fails', async () => {
    const results = await Promise.all(
      [140, 160].map((unitCredits) =>
        f.call('put', f.superAdmin.cookie, '/model-pricing/gpt-image-2/2K', {
          ...body,
          unitCredits,
        }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const audit = vi
      .spyOn(f.app.get(AdminAuditService), 'write')
      .mockRejectedValueOnce(new Error('Injected audit rollback'));
    try {
      expect(
        (await f.call('put', f.superAdmin.cookie, '/model-pricing/gpt-image-2/4K', body)).status,
      ).toBe(500);
    } finally {
      audit.mockRestore();
    }
    expect(await f.db.database.client.modelCreditPrice.count({ where: { resolution: '4K' } })).toBe(
      0,
    );
  });
  it('requires current permission on replay and refuses granting pricing to custom roles', async () => {
    expect(validPermissionSet(['model-pricing.write'])).toBe(false);
    expect(validPermissionSet(['models.read', 'model-pricing.write'])).toBe(true);
    expect(validPermissionSet(['dashboard.read', 'models.read', 'model-pricing.write'], true)).toBe(
      false,
    );
    for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS))
      expect(permissions.includes('model-pricing.write')).toBe(role === 'super_admin');
    const reader = await fixtureAdmin(f.db, ['model_operator']);
    expect((await f.call('get', reader.cookie, '/model-pricing')).status).toBe(200);
    expect((await f.call('put', reader.cookie, path, body)).status).toBe(403);
    const response = await f.post(f.superAdmin.cookie, '/team/roles', {
      key: 'custom_pricing',
      name: 'Price',
      description: '',
      permissions: ['dashboard.read', 'models.read', 'model-pricing.write'],
      reason: body.reason,
    });
    expect(response.status).toBe(400);
    const actor = await fixtureAdmin(f.db, ['super_admin']);
    const key = randomUUID();
    const p = '/model-pricing/gemini-2.5-flash-image/1K';
    expect((await f.call('put', actor.cookie, p, body, key)).status).toBe(200);
    await f.db.database.client.adminAccountRole.delete({
      where: { accountId_roleKey: { accountId: actor.account.id, roleKey: 'super_admin' } },
    });
    await f.db.database.client.adminAccountRole.create({
      data: { accountId: actor.account.id, roleKey: 'model_operator' },
    });
    expect((await f.call('put', actor.cookie, p, body, key)).status).toBe(403);
  });
  it('keeps exact origin, development and loopback write gates on save and replay', async () => {
    expect(
      (
        await request(f.app.getHttpServer())
          .put(`/api/admin${path}`)
          .set('Origin', 'http://evil.test')
          .set('Cookie', f.superAdmin.cookie)
          .send(body)
      ).status,
    ).toBe(403);
    await expect(adminApp(f.db, { nodeEnv: 'production' })).rejects.toThrow(
      /production activation/,
    );
    const remote = await f.app
      .get(AdminAuthService)
      .resolve(f.superAdmin.cookie.split('=')[1]!, '203.0.113.1');
    await expect(
      f.app.get(AdminModelPricingService).save(remote, randomUUID(), 'gpt-image-2', '1K', body),
    ).rejects.toMatchObject({ status: 503, code: 'ADMIN_TEAM_WRITES_DISABLED' });
    for (const config of [
      { host: '0.0.0.0' },
      {
        nodeEnv: 'development',
        host: '127.0.0.1',
        admin: {
          enabled: true,
          origins: ['https://admin.example.test'],
          encryptionKey: Buffer.alloc(32, 12).toString('base64'),
        },
      },
    ]) {
      const app = await adminApp(f.db, config);
      try {
        const origin = 'admin' in config ? 'https://admin.example.test' : adminOrigin;
        const r = await request(app.getHttpServer())
          .put(`/api/admin${path}`)
          .set('Origin', origin)
          .set('Cookie', f.superAdmin.cookie)
          .set('Idempotency-Key', randomUUID())
          .send(body);
        expect(r.status).toBe(503);
      } finally {
        await app.close();
      }
    }
  });
  it('keeps retired model history readable without offering it for sale', async () => {
    await f.db.database.client.adminAuditEvent.create({
      data: {
        action: 'model-pricing.import',
        outcome: 'allowed',
        metadata: {
          modelId: 'retired-reviewed-model',
          resolution: '1K',
          source: 'offline_import',
          beforeVersion: 0,
          beforeUnitCredits: null,
          beforeEnabled: null,
          afterVersion: 1,
          afterUnitCredits: 100,
          afterEnabled: true,
        },
      },
    });
    const history = await f.call(
      'get',
      f.superAdmin.cookie,
      '/model-pricing/retired-reviewed-model/history',
    );
    expect(history.status).toBe(200);
    expect(history.body.data.items[0]).toMatchObject({
      actor: 'offline_import',
      after: { unitCredits: 100 },
    });
    expect(
      (await f.call('put', f.superAdmin.cookie, '/model-pricing/retired-reviewed-model/1K', body))
        .status,
    ).toBe(400);
  });
  it('paginates audit timestamps with PostgreSQL microseconds without skipping tied rows', async () => {
    const schema = new URL(f.db.url).searchParams.get('schema')!;
    if (!/^viviai_test_[a-f0-9]+$/.test(schema)) throw new Error('Only owned test schemas');
    const sql = new pg.Client({ connectionString: f.db.url });
    await sql.connect();
    try {
      await sql.query(`SET search_path TO "${schema}"`);
      const hasPublicAudit =
        (await sql.query(`SELECT to_regclass('public."AdminAuditEvent"') AS name`)).rows[0].name !==
        null;
      const publicCount = async () =>
        hasPublicAudit
          ? Number((await sql.query('SELECT count(*) FROM public."AdminAuditEvent"')).rows[0].count)
          : 0;
      const beforePublicCount = await publicCount();
      for (let i = 0; i < 3; i++) {
        const metadata = JSON.stringify({
          modelId: 'gemini-3.1-flash-lite-image',
          resolution: '1K',
          source: 'offline_import',
          beforeVersion: i,
          afterVersion: i + 1,
          beforeUnitCredits: i ? 100 : null,
          beforeEnabled: i ? true : null,
          afterUnitCredits: 100,
          afterEnabled: true,
        });
        await sql.query(
          `INSERT INTO "${schema}"."AdminAuditEvent" (id, action, outcome, metadata, "createdAt") VALUES ($1::uuid, 'model-pricing.import', 'allowed', $2::jsonb, TIMESTAMPTZ '2020-01-01 00:00:00.123456+00')`,
          [randomUUID(), metadata],
        );
      }
      expect(await publicCount()).toBe(beforePublicCount);
    } finally {
      await sql.end();
    }
    const ids = [];
    let cursor: string | null = null;
    for (let page = 0; page < 3; page++) {
      const r = await f.call(
        'get',
        f.superAdmin.cookie,
        `/model-pricing/gemini-3.1-flash-lite-image/history?limit=1${cursor ? `&cursor=${cursor}` : ''}`,
      );
      expect(r.status).toBe(200);
      expect(r.body.data.items, `history page ${page}`).toHaveLength(1);
      ids.push(r.body.data.items[0].id);
      cursor = r.body.data.nextCursor;
    }
    expect(new Set(ids).size).toBe(3);
    expect(cursor).toBeNull();
  });
});

// The operator console and the public catalog must agree on what can be served. Availability is a
// property of model + specification + whichever channel is enabled, never of one channel alone.
describe('admin model credit prices with the third-party channel enabled', () => {
  let f: Awaited<ReturnType<typeof teamFixture>>;
  beforeAll(async () => {
    f = await teamFixture({
      thirdPartyImages: loadThirdPartyImageConfig({
        NODE_ENV: 'development',
        SUB2API_ENABLED: 'true',
        SUB2API_BASE_URL: 'http://localhost:8080',
        SUB2API_API_KEY: 'do-not-print',
        SUB2API_MODEL_ID: 'gpt-5.6',
        SUB2API_DAILY_BUDGET_MICROS: '10000000',
        SUB2API_IMAGE_MODELS_JSON: JSON.stringify({
          revision: 'pricing-v1',
          models: OPENAI_IMAGES_MODEL_IDS.map((modelId) => ({
            modelId,
            enabledResolutions: ['1K'],
            reserveCostMicros: '1000000',
            pricing: {
              version: 'pricing-cost-v1',
              currency: 'USD',
              rates: {
                input_text_tokens: '1',
                input_image_tokens: '1',
                output_image_tokens: '1',
              },
            },
          })),
        }),
      }),
    });
  });
  afterAll(async () => {
    await f?.close();
  });
  it('reports models that only the third-party channel serves as runtime available', async () => {
    for (const modelId of OPENAI_IMAGES_MODEL_IDS) {
      const path = `/model-pricing/${modelId}/1K`;
      expect((await f.call('get', f.superAdmin.cookie, path)).body.data, modelId).toMatchObject({
        runtimeAvailable: true,
        availabilityReason: 'unpriced',
      });
      const body = {
        unitCredits: 120,
        enabled: true,
        expectedVersion: 0,
        reason: '测试第三方渠道模型积分定价',
      };
      expect((await f.call('put', f.superAdmin.cookie, path, body)).status, modelId).toBe(200);
      expect((await f.call('get', f.superAdmin.cookie, path)).body.data, modelId).toMatchObject({
        unitCredits: 120,
        enabled: true,
        version: 1,
        runtimeAvailable: true,
        availabilityReason: 'available',
      });
    }
    // The third-party channel carries the OpenAI Images protocol only, so a Google model stays
    // unavailable: availability follows the protocol the model needs, not "any channel is up".
    for (const modelId of ['gemini-2.5-flash-image', 'gemini-3-pro-image']) {
      expect(
        (await f.call('get', f.superAdmin.cookie, `/model-pricing/${modelId}/1K`)).body.data
          .runtimeAvailable,
        modelId,
      ).toBe(false);
    }
  });
});
