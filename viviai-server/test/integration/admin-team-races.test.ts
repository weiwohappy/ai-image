import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { expect, it } from 'vitest';
import { teamFixture } from '../helpers/admin-team.js';
import { adminOrigin, fixtureAdmin } from '../helpers/admin.js';
import { AdminAuthService } from '../../src/modules/admin/auth.service.js';
import { AdminMembersService } from '../../src/modules/admin/team/members.service.js';
const reason = '管理员并发操作保护验证';
it('commits one invitation for concurrent identical idempotency keys and releases its link once', async () => {
  const f = await teamFixture();
  try {
    const key = randomUUID();
    const body = {
      email: 'same-key@example.test',
      displayName: '并发创建',
      roles: ['support'],
      reason,
    };
    const responses = await Promise.all([
      f.post(f.manager.cookie, '/team/invitations', body, key),
      f.post(f.manager.cookie, '/team/invitations', body, key),
    ]);
    expect(responses.map((r) => r.status)).toEqual([201, 201]);
    expect(responses.filter((r) => r.body.data.link)).toHaveLength(1);
    expect(await f.db.database.client.adminInvitation.count({ where: { email: body.email } })).toBe(
      1,
    );
    expect(
      await f.db.database.client.adminAuditEvent.count({
        where: { action: 'team.invitation.create', outcome: 'allowed' },
      }),
    ).toBe(1);
  } finally {
    await f.close();
  }
});
it('serializes mutual super disable, leaving one usable super and no deadlock', async () => {
  const f = await teamFixture();
  try {
    const second = await fixtureAdmin(f.db, ['super_admin']);
    const responses = await Promise.all([
      f.post(f.superAdmin.cookie, `/team/members/${second.account.id}/disable`, {
        expectedVersion: 1,
        reason,
      }),
      f.post(second.cookie, `/team/members/${f.superAdmin.account.id}/disable`, {
        expectedVersion: 1,
        reason,
      }),
    ]);
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.every((r) => [201, 401, 409].includes(r.status))).toBe(true);
    expect(
      await f.db.database.client.adminAccount.count({
        where: {
          status: 'active',
          disabledAt: null,
          roleBindings: { some: { roleKey: 'super_admin' } },
        },
      }),
    ).toBe(1);
  } finally {
    await f.close();
  }
});
it('serializes custom role permission changes and member assignment with fresh grants', async () => {
  const f = await teamFixture();
  try {
    const body = {
      key: 'custom_race',
      name: '并发角色',
      description: '',
      permissions: ['dashboard.read'],
      reason,
    };
    expect((await f.post(f.superAdmin.cookie, '/team/roles', body)).status).toBe(201);
    const responses = await Promise.all([
      f.call('patch', f.superAdmin.cookie, `/team/roles/${body.key}`, {
        name: body.name,
        description: '',
        permissions: ['dashboard.read', 'users.read'],
        expectedVersion: 1,
        reason,
      }),
      f.call('put', f.manager.cookie, `/team/members/${f.ordinary.account.id}/roles`, {
        roles: [body.key],
        expectedVersion: 1,
        reason,
      }),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    const role = await f.db.database.client.adminRole.findUniqueOrThrow({
      where: { key: body.key },
    });
    expect(role.permissions).toEqual(['dashboard.read', 'users.read']);
    const member = await f.db.database.client.adminAccount.findUniqueOrThrow({
      where: { id: f.ordinary.account.id },
      include: { roleBindings: { include: { role: true } } },
    });
    expect(member.roleBindings[0]!.role.permissions).toEqual(['dashboard.read', 'users.read']);
    expect(member.authVersion).toBeGreaterThanOrEqual(2);
    expect((await f.call('get', f.ordinary.cookie, '/me')).status).toBe(401);
  } finally {
    await f.close();
  }
});
it.each(['rotate', 'edit'] as const)(
  'serializes invitation %s versus acceptance with no silent permission escalation',
  async (action) => {
    const f = await teamFixture();
    try {
      const created = await f.post(f.manager.cookie, '/team/invitations', {
        email: 'race@example.test',
        displayName: '并发邀请',
        roles: ['support'],
        reason,
      });
      const id = created.body.data.resourceId;
      const token = new URLSearchParams(new URL(created.body.data.link).hash.split('?')[1]).get(
        'token',
      );
      const [change, accept] = await Promise.all([
        action === 'edit'
          ? f.call('patch', f.manager.cookie, `/team/invitations/${id}`, {
              expectedVersion: 1,
              reason,
              roles: ['finance'],
            })
          : f.post(f.manager.cookie, `/team/invitations/${id}/rotate`, {
              expectedVersion: 1,
              reason,
            }),
        request(f.app.getHttpServer())
          .post('/api/admin/auth/invitations/accept')
          .set('Origin', adminOrigin)
          .send({
            email: 'race@example.test',
            displayName: '并发邀请',
            password: 'race-password-12345',
            token,
          }),
      ]);
      if (accept.status === 201) {
        expect(change.status).toBe(409);
        const member = await f.db.database.client.adminAccount.findUniqueOrThrow({
          where: { email: 'race@example.test' },
          include: { roleBindings: true },
        });
        expect(member.roleBindings.map((b) => b.roleKey)).toEqual(['support']);
      } else {
        expect(accept.status).toBe(401);
        expect(change.status).toBe(action === 'edit' ? 200 : 201);
      }
    } finally {
      await f.close();
    }
  },
);
it('reauthorizes an already resolved session before mutation after authorization removal', async () => {
  const f = await teamFixture();
  try {
    const auth = f.app.get(AdminAuthService),
      members = f.app.get(AdminMembersService);
    const old = await auth.resolve(f.manager.cookie.split('=')[1]!, '127.0.0.1');
    expect(
      (
        await f.call('put', f.superAdmin.cookie, `/team/members/${f.manager.account.id}/roles`, {
          roles: ['support'],
          expectedVersion: 1,
          reason,
        })
      ).status,
    ).toBe(200);
    await expect(
      members.change(old, randomUUID(), f.ordinary.account.id, 'edit', {
        displayName: '不应写入',
        expectedVersion: 1,
        reason,
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(
      (
        await f.db.database.client.adminAccount.findUniqueOrThrow({
          where: { id: f.ordinary.account.id },
        })
      ).displayName,
    ).toBe('Test operator');
  } finally {
    await f.close();
  }
});
