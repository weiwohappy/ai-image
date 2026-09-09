import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';
import { adminApp, fixtureAdmin, fixtureJob } from '../helpers/admin.js';
import { SettlementService } from '../../src/modules/generation/settlement.service.js';
import { WalletService } from '../../src/modules/wallet/wallet.service.js';
import { createTestStorage } from '../helpers/storage.js';
import { loadOfficialConfig } from '../../src/modules/providers/official-config.js';
describe('scoped administrator read models', () => {
  let db: TestDatabase;
  let app: INestApplication;
  let owner: string;
  let support: string;
  let model: string;
  let system: string;
  let finance: string;
  let content: string;
  let userId: string;
  beforeAll(async () => {
    db = await createTestDatabase();
    app = await adminApp(db);
    [owner, support, model, system, finance, content] = (await Promise.all(
      ['owner', 'support', 'model_operator', 'system_admin', 'finance', 'content_operator'].map(
        async (role) => (await fixtureAdmin(db, [role])).cookie,
      ),
    )) as [string, string, string, string, string, string];
    const user = await db.database.client.user.create({
      data: {
        email: 'customer-private@example.test',
        username: 'private-user',
        passwordHash: 'never-display-hash',
      },
    });
    userId = user.id;
    await db.database.client.user.create({
      data: { email: 'another@example.test', username: 'second-user', passwordHash: 'secret' },
    });
    await db.database.client.creditLot.create({
      data: {
        userId,
        sourceId: 'test-seed',
        issued: 9007199254740993n,
        available: 9007199254740990n,
        consumed: 3n,
        revenueMinor: 123n,
      },
    });
  });
  afterAll(async () => {
    await app?.close();
    await db?.cleanup();
  });
  const get = (path: string, cookie = owner) =>
    request(app.getHttpServer()).get(`/api/admin/${path}`).set('Cookie', cookie);
  it('uses exact search, masked emails, and decimal-string credit balances', async () => {
    const response = await get('users?q=customer-private%40example.test');
    expect(response.status).toBe(200);
    expect(response.body.data.rows).toHaveLength(1);
    expect(response.body.data.rows[0].available).toBe('9007199254740990');
    expect(JSON.stringify(response.body)).not.toContain('customer-private@example.test');
    expect(JSON.stringify(response.body)).not.toContain('never-display-hash');
    expect((await get('users?q=customer')).status).toBe(400);
    const detail = await get(`users/${userId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.tables.length).toBeGreaterThan(0);
    expect((await get(`users/${userId}/credit-lots`)).body.data.rows[0].consumed).toBe('3');
  });
  it('paginates deterministically and rejects malformed cursors, invalid dates and irrelevant filters', async () => {
    const first = await get('users?limit=1');
    expect(first.body.data.rows).toHaveLength(1);
    expect(first.body.data.nextCursor).toBeTypeOf('string');
    const second = await get(
      `users?limit=1&cursor=${encodeURIComponent(first.body.data.nextCursor)}`,
    );
    expect(second.body.data.rows).toHaveLength(1);
    expect(second.body.data.rows[0].id).not.toBe(first.body.data.rows[0].id);
    expect((await get('users?from=2026-09-09T01%3A00%3A00%2B08%3A00')).status).toBe(200);
    for (const path of [
      'users?cursor=bad',
      'users?limit=101',
      'users?from=2026-02-30',
      'users?from=2026-09-10T00:00:00Z&to=2026-09-09T00:00:00Z',
      'users?modelId=no',
      'users?limit=1&limit=2',
    ])
      expect((await get(path)).status).toBe(400);
  });
  it('reevaluates resource permission for every role and avoids costs in support projections', async () => {
    expect((await get('users', model)).status).toBe(403);
    expect((await get('jobs', system)).status).toBe(403);
    expect((await get('audit-events', support)).status).toBe(403);
    expect((await get('provider-accounts', finance)).status).toBe(403);
    expect((await get('models', model)).status).toBe(200);
    const supportDashboard = await get('dashboard', support);
    expect(supportDashboard.status).toBe(200);
    expect(JSON.stringify(supportDashboard.body)).not.toContain('Cost');
    const financeDashboard = await get('dashboard', finance);
    expect(
      financeDashboard.body.data.metrics.find((m: { key: string }) => m.key === 'refunds')?.value,
    ).toBeNull();
    const contentDashboard = await get('dashboard', content);
    expect(contentDashboard.body.data.metrics).toEqual([]);
    expect(contentDashboard.body.data.notices.join(' ')).toContain('尚未接入');
    expect((await get('administrators', system)).status).toBe(200);
    expect((await get('roles', system)).status).toBe(200);
  });
  it('shows all five model definitions as disabled without claiming live verification', async () => {
    const response = await get('models');
    expect(response.body.data.rows).toHaveLength(5);
    expect(response.body.data.rows.every((r: { enabled: boolean }) => r.enabled === false)).toBe(
      true,
    );
    const detail = await get('models/gemini-3.1-flash-lite-image');
    expect(detail.status).toBe(200);
    expect(detail.body.data.tables[0].rows[0].width).toBe(1024);
    expect(JSON.stringify(detail.body)).not.toContain('credentials');
  });
  it('records actual lifecycle transitions once and leaves historical missing timestamps unavailable', async () => {
    const job = await fixtureJob(db);
    const storage = await createTestStorage();
    const lot = await db.database.client.creditLot.create({
      data: {
        userId: job.userId,
        sourceId: 'lifecycle-test',
        issued: 30n,
        available: 0n,
        held: 30n,
      },
    });
    await db.database.client.creditReservation.create({
      data: {
        userId: job.userId,
        jobId: job.id,
        itemId: job.items[0]!.id,
        amount: 30n,
        allocations: { create: { lotId: lot.id, amount: 30n } },
      },
    });
    try {
      const before = await get(`jobs/${job.id}`);
      expect(before.status).toBe(200);
      expect(
        before.body.data.tables.find((t: { title: string }) => t.title === '生命周期事件').rows,
      ).toEqual([]);
      const settle = new SettlementService(
        db.database,
        new WalletService(db.database),
        storage.store,
      );
      const eventTime = new Date();
      await db.database.transaction((tx) =>
        settle.fail(tx, job.items[0]!.id, 'TEST_DEADLINE', false, eventTime),
      );
      await db.database.transaction((tx) => settle.fail(tx, job.items[0]!.id, 'TEST_DEADLINE'));
      const events = await db.database.client.generationLifecycleEvent.findMany({
        where: { itemId: job.items[0]!.id },
      });
      expect(events).toHaveLength(1);
      expect(events[0]!.event).toBe('failed');
      expect(events[0]!.createdAt.toISOString()).toBe(eventTime.toISOString());
      expect(
        (await get(`jobs/${job.id}`)).body.data.tables.find(
          (t: { title: string }) => t.title === '生命周期事件',
        ).rows,
      ).toHaveLength(1);
    } finally {
      await storage.cleanup();
    }
  });
  it('aggregates actual provider account scopes once, deduplicates budget alerts and resolves only cleared conditions', async () => {
    const official = loadOfficialConfig({
      GEMINI_API_KEY: 'offline-test-only',
      OFFICIAL_IMAGE_MODELS_JSON: JSON.stringify({
        revision: 'test-v1',
        accounts: {
          google: {
            scope: 'shared-account',
            credentialVersion: 'test-v1',
            concurrency: 4,
            maxUnknown: 1,
            dailyBudgetMicros: '1000000',
          },
        },
        models: ['gemini-2.5-flash-image', 'gemini-3.1-flash-image'].map((modelId) => ({
          modelId,
          sales: { '1K': 30 },
          reserveCostMicros: '1000',
          pricing: {
            version: 'test-v1',
            currency: 'USD',
            rates: {
              input_text_tokens: '1',
              input_image_tokens: '1',
              output_text_tokens: '1',
              output_image_tokens: '1',
              thought_tokens: '1',
            },
          },
        })),
      }),
    });
    const configured = await adminApp(db, {
      officialImages: official,
      simulationProviderEnabled: false,
    });
    const budgetId = `official-usd-google-shared-account:${new Date().toISOString().slice(0, 10)}`;
    await db.database.client.providerQuota.create({
      data: { id: 'official-google-shared-account', inflight: 2, unknown: 1 },
    });
    await db.database.client.providerBudget.create({
      data: { id: budgetId, reservedMicros: 100000n, consumedMicros: 700000n },
    });
    try {
      const providers = await request(configured.getHttpServer())
        .get('/api/admin/provider-accounts')
        .set('Cookie', owner);
      expect(providers.status).toBe(200);
      expect(providers.body.data.rows).toHaveLength(1);
      expect(providers.body.data.rows[0]).toMatchObject({
        inflight: 2,
        unknown: 1,
        reservedMicros: '100000',
        consumedMicros: '700000',
        dailyBudgetMicros: '1000000',
        providerBalance: null,
      });
      const alerts = () =>
        request(configured.getHttpServer())
          .get('/api/admin/alerts?status=active')
          .set('Cookie', owner);
      const concurrent = await Promise.all([alerts(), alerts(), alerts()]);
      expect(concurrent.every((r) => r.status === 200)).toBe(true);
      expect(
        await db.database.client.adminAlert.count({
          where: { kind: 'budget_80_percent', resolved: false },
        }),
      ).toBe(1);
      await db.database.client.providerBudget.update({
        where: { id: budgetId },
        data: { reservedMicros: 0n, consumedMicros: 100n },
      });
      await alerts();
      expect(
        await db.database.client.adminAlert.count({
          where: { kind: 'budget_80_percent', resolved: false },
        }),
      ).toBe(0);
    } finally {
      await configured.close();
    }
  });
});
