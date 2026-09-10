import { expect, it } from 'vitest';
import { teamFixture } from '../helpers/admin-team.js';
import { fixtureAdmin } from '../helpers/admin.js';
import { AdminQueryService } from '../../src/modules/admin/query.service.js';
import { AdminAuthService } from '../../src/modules/admin/auth.service.js';
it('uses custom capabilities and underlying permission intersections for dashboard and alerts', async () => {
  const f = await teamFixture();
  try {
    await f.db.database.client.adminRole.create({
      data: {
        key: 'custom_costs_only',
        name: '成本查看',
        permissions: ['dashboard.read', 'costs.read'],
      },
    });
    const costs = await fixtureAdmin(f.db, ['custom_costs_only']);
    const dashboard = await f.call('get', costs.cookie, '/dashboard');
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.data.metrics).toEqual([]);
    await f.db.database.client.adminRole.create({
      data: {
        key: 'custom_stats',
        name: '财务统计',
        permissions: [
          'dashboard.read',
          'dashboard.finance.read',
          'orders.read',
          'credits.read',
          'alerts.read',
          'alerts.service.read',
        ],
      },
    });
    const stats = await fixtureAdmin(f.db, ['custom_stats']);
    const financial = await f.call('get', stats.cookie, '/dashboard');
    expect(financial.body.data.metrics.map((m: { key: string }) => m.key)).toContain('paid');
    expect(financial.body.data.metrics.map((m: { key: string }) => m.key)).not.toContain('users');
    expect(financial.body.data.metrics.map((m: { key: string }) => m.key)).not.toContain(
      'realCost',
    );
    const context = await f.app
      .get(AdminAuthService)
      .resolve(stats.cookie.split('=')[1]!, '127.0.0.1');
    const missingUnderlying = {
      ...context.actor,
      permissions: ['dashboard.read', 'dashboard.finance.read', 'costs.read'],
    };
    expect((await f.app.get(AdminQueryService).dashboard(missingUnderlying, {})).metrics).toEqual(
      [],
    );
    await f.db.database.client.adminAlert.createMany({
      data: ['service', 'model'].map((category) => ({
        sourceKey: `scope-test-${category}`,
        category,
        kind: 'scope_test',
        resourceId: stats.account.id,
      })),
    });
    const alerts = await f.call('get', stats.cookie, '/alerts');
    expect(alerts.status).toBe(200);
    expect(alerts.body.data.rows.map((row: { category: string }) => row.category)).toEqual([
      'service',
    ]);
  } finally {
    await f.close();
  }
});

it('honors exact filters and stable pages while returning only public member fields', async () => {
  const f = await teamFixture();
  try {
    const first = await f.call('get', f.manager.cookie, '/team/members?limit=1');
    const second = await f.call(
      'get',
      f.manager.cookie,
      `/team/members?limit=1&cursor=${encodeURIComponent(first.body.data.nextCursor)}`,
    );
    expect(first.body.data.items[0].id).not.toBe(second.body.data.items[0].id);
    const filtered = await f.call(
      'get',
      f.manager.cookie,
      `/team/members?q=${encodeURIComponent(f.ordinary.account.email)}&role=support&status=active`,
    );
    expect(filtered.body.data.items).toHaveLength(1);
    expect(filtered.body.data.items[0].email).toBe(f.ordinary.account.email);
    for (const secret of [
      'passwordHash',
      'encryptedMfaSecret',
      'lastTotpCounter',
      'extraPermissions',
      'tokenHash',
    ])
      expect(JSON.stringify(filtered.body)).not.toContain(secret);
    for (const query of [
      'q=partial',
      'limit=101',
      'cursor=bad',
      'status=unknown',
      'email=other%40example.test',
    ])
      expect((await f.call('get', f.manager.cookie, `/team/members?${query}`)).status).toBe(400);
    expect(
      (
        await f.call('get', f.manager.cookie, '/team/permission-catalog')
      ).body.data.assignableRoles.some((r: { key: string }) =>
        ['super_admin', 'owner', 'system_admin'].includes(r.key),
      ),
    ).toBe(false);
  } finally {
    await f.close();
  }
});
