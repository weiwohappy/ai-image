import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { AdminAuditService } from '../../src/modules/admin/audit.service.js';
import request from 'supertest';
import { adminOrigin, fixtureAdmin } from '../helpers/admin.js';
import { teamFixture } from '../helpers/admin-team.js';

it('creates one invitation and never replays its secret link', async () => {
  const f = await teamFixture();
  try {
    const body = {
      email: 'invitee@example.test',
      displayName: '客服同事',
      roles: ['support'],
      reason: '新增客服岗位成员',
    };
    const key = randomUUID();
    const first = await f.post(f.superAdmin.cookie, '/team/invitations', body, key);
    expect(first.status).toBe(201);
    expect(first.body.data.link).toContain('#/accept?token=');
    const again = await f.post(f.superAdmin.cookie, '/team/invitations', body, key);
    expect(again.body.data.resourceId).toBe(first.body.data.resourceId);
    expect(again.body.data.link).toBeUndefined();
    expect(again.body.data.linkUnavailable).toBe(true);
    expect(await f.db.database.client.adminInvitation.count({ where: { email: body.email } })).toBe(
      1,
    );
  } finally {
    await f.close();
  }
});

const reason = '按照已批准岗位需求调整';
it('deletes an unused custom role logically, reserving its key and rejecting expired invitation regeneration', async () => {
  const f = await teamFixture();
  try {
    const body = {
      key: 'custom_expired',
      name: '已结束岗位',
      description: '',
      permissions: ['dashboard.read'],
      reason,
    };
    expect((await f.post(f.superAdmin.cookie, '/team/roles', body)).status).toBe(201);
    const invitation = await f.post(f.manager.cookie, '/team/invitations', {
      email: 'expired@example.test',
      displayName: '到期邀请',
      roles: [body.key],
      reason,
    });
    const id = invitation.body.data.resourceId;
    await f.db.database.client.adminInvitation.update({
      where: { id },
      data: { expiresAt: new Date(0) },
    });
    expect(
      (await f.call('get', f.superAdmin.cookie, `/team/roles/${body.key}`)).body.data
        .invitationCount,
    ).toBe(0);
    expect(
      (
        await f.call('delete', f.superAdmin.cookie, `/team/roles/${body.key}`, {
          expectedVersion: 1,
          reason,
        })
      ).status,
    ).toBe(200);
    expect((await f.call('get', f.superAdmin.cookie, `/team/roles/${body.key}`)).status).toBe(404);
    expect((await f.post(f.superAdmin.cookie, '/team/roles', body)).status).toBe(409);
    expect(
      (
        await f.post(f.manager.cookie, `/team/invitations/${id}/rotate`, {
          expectedVersion: 1,
          reason,
        })
      ).status,
    ).toBe(400);
    expect(
      await f.db.database.client.adminRole.count({
        where: { key: body.key, deletedAt: { not: null } },
      }),
    ).toBe(1);
  } finally {
    await f.close();
  }
});

it('renames a custom role without invalidating its members or their record versions', async () => {
  const f = await teamFixture();
  try {
    await f.db.database.client.adminRole.create({
      data: { key: 'custom_names', name: '旧岗位名', permissions: ['dashboard.read'] },
    });
    const member = await fixtureAdmin(f.db, ['custom_names']);
    expect(
      (
        await f.call('patch', f.superAdmin.cookie, '/team/roles/custom_names', {
          name: '新岗位名',
          description: '仅名称说明改变',
          permissions: ['dashboard.read'],
          expectedVersion: 1,
          reason,
        })
      ).status,
    ).toBe(200);
    expect((await f.call('get', member.cookie, '/me')).status).toBe(200);
    expect(
      (
        await f.db.database.client.adminAccount.findUniqueOrThrow({
          where: { id: member.account.id },
        })
      ).version,
    ).toBe(1);
  } finally {
    await f.close();
  }
});
it('enforces actor, target, self, strict-input and version gates and audits rejection', async () => {
  const f = await teamFixture();
  try {
    const path = `/team/members/${f.ordinary.account.id}`;
    const edit = { displayName: '更新姓名', expectedVersion: 1, reason };
    expect((await f.call('patch', f.ordinary.cookie, path, edit)).status).toBe(403);
    expect(
      (await f.call('patch', f.manager.cookie, `/team/members/${f.superAdmin.account.id}`, edit))
        .status,
    ).toBe(403);
    expect(
      (
        await f.call('patch', f.manager.cookie, path, {
          ...edit,
          extraPermissions: ['sensitive.read'],
        })
      ).status,
    ).toBe(400);
    const key = randomUUID();
    const first = await f.call('patch', f.manager.cookie, path, edit, key);
    expect(first.status).toBe(200);
    expect(first.body.data.version).toBe(2);
    expect((await f.call('patch', f.manager.cookie, path, edit, key)).body.data.version).toBe(2);
    expect(
      (await f.call('patch', f.manager.cookie, path, { ...edit, displayName: '另一个姓名' }, key))
        .body.code,
    ).toBe('ADMIN_IDEMPOTENCY_CONFLICT');
    expect((await f.call('patch', f.manager.cookie, path, edit)).body.code).toBe(
      'ADMIN_VERSION_CONFLICT',
    );
    expect(
      (
        await f.post(f.superAdmin.cookie, `/team/members/${f.superAdmin.account.id}/disable`, {
          expectedVersion: 1,
          reason,
        })
      ).body.code,
    ).toBe('ADMIN_SELF_PROTECTED');
    expect((await f.call('get', f.ordinary.cookie, '/me')).status).toBe(200);
    expect(
      await f.db.database.client.adminAuditEvent.count({
        where: { outcome: 'denied', action: 'team.member.edit' },
      }),
    ).toBeGreaterThan(0);
  } finally {
    await f.close();
  }
});

it.each([{ nodeEnv: 'test' }, { host: '0.0.0.0' }])(
  'disables team writes outside loopback development: %j',
  async (config) => {
    const f = await teamFixture(config);
    try {
      const response = await f.post(f.superAdmin.cookie, '/team/invitations', {
        email: 'blocked@example.test',
        displayName: '被阻止邀请',
        roles: ['support'],
        reason,
      });
      expect(response.status).toBe(503);
      expect(await f.db.database.client.adminInvitation.count()).toBe(0);
    } finally {
      await f.close();
    }
  },
);

it('requires Origin and denies forwarded-IP bypass and protected invitation grants', async () => {
  const f = await teamFixture();
  try {
    const body = {
      email: 'scope@example.test',
      displayName: '普通成员',
      roles: ['finance'],
      reason,
    };
    expect(
      (
        await request(f.app.getHttpServer())
          .post('/api/admin/team/invitations')
          .set('Cookie', f.manager.cookie)
          .set('Origin', 'https://evil.example')
          .set('X-Forwarded-For', '127.0.0.1')
          .send(body)
      ).status,
    ).toBe(403);
    expect((await f.post(f.manager.cookie, '/team/invitations', body)).status).toBe(201);
    expect(
      (
        await f.post(f.manager.cookie, '/team/invitations', {
          ...body,
          email: 'owner@example.test',
          roles: ['owner'],
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await f.post(f.superAdmin.cookie, '/team/invitations', {
          ...body,
          email: 'super@example.test',
          roles: ['super_admin'],
        })
      ).status,
    ).toBe(403);
  } finally {
    await f.close();
  }
});

it('grants roles through bindings, invalidates old sessions and preserves extra permissions', async () => {
  const f = await teamFixture();
  try {
    const target = await fixtureAdmin(f.db, ['support'], ['sensitive.read']);
    const path = `/team/members/${target.account.id}/roles`;
    const body = { roles: ['finance'], expectedVersion: 1, reason };
    expect((await f.call('put', f.manager.cookie, path, body)).status).toBe(403);
    expect((await f.call('put', f.superAdmin.cookie, path, body)).status).toBe(200);
    expect((await f.call('get', target.cookie, '/me')).status).toBe(401);
    const saved = await f.db.database.client.adminAccount.findUniqueOrThrow({
      where: { id: target.account.id },
      include: { roleBindings: true },
    });
    expect(saved.roleBindings.map((b) => b.roleKey)).toEqual(['finance']);
    expect(saved.extraPermissions).toEqual(['sensitive.read']);
    expect(saved.authVersion).toBe(2);
  } finally {
    await f.close();
  }
});

it('disables and enables without inventing pending MFA activation or reviving old sessions', async () => {
  const f = await teamFixture();
  try {
    await f.db.database.client.adminAccount.update({
      where: { id: f.ordinary.account.id },
      data: { status: 'pending', lastTotpCounter: null },
    });
    const path = `/team/members/${f.ordinary.account.id}`;
    expect(
      (await f.post(f.manager.cookie, `${path}/disable`, { expectedVersion: 1, reason })).status,
    ).toBe(201);
    expect((await f.call('get', f.manager.cookie, path)).body.data).toMatchObject({
      status: 'disabled',
      activated: false,
    });
    expect(
      (await f.call('get', f.manager.cookie, '/administrators?status=disabled')).body.data.rows.map(
        (m: { id: string }) => m.id,
      ),
    ).toContain(f.ordinary.account.id);
    expect(
      (await f.post(f.manager.cookie, `${path}/password-resets`, { expectedVersion: 2, reason }))
        .status,
    ).toBe(409);
    expect(
      (await f.post(f.manager.cookie, `${path}/enable`, { expectedVersion: 2, reason })).status,
    ).toBe(201);
    expect((await f.call('get', f.manager.cookie, path)).body.data).toMatchObject({
      status: 'pending',
      activated: false,
    });
    expect((await f.call('get', f.ordinary.cookie, '/me')).status).toBe(401);
  } finally {
    await f.close();
  }
});

it('rolls back the mutation and receipt if the success audit cannot be persisted', async () => {
  const f = await teamFixture();
  try {
    const audit = vi
      .spyOn(f.app.get(AdminAuditService), 'write')
      .mockRejectedValueOnce(new Error('injected audit storage failure'));
    const result = await f.post(f.superAdmin.cookie, '/team/invitations', {
      email: 'atomic@example.test',
      displayName: '事务验证',
      roles: ['support'],
      reason,
    });
    audit.mockRestore();
    expect(result.status).toBe(500);
    expect(
      await f.db.database.client.adminInvitation.count({ where: { email: 'atomic@example.test' } }),
    ).toBe(0);
    expect(await f.db.database.client.adminCommandReceipt.count()).toBe(0);
  } finally {
    await f.close();
  }
});

it('expires reset links and durably rate limits anonymous token guesses', async () => {
  const f = await teamFixture();
  try {
    const issued = await f.post(
      f.manager.cookie,
      `/team/members/${f.ordinary.account.id}/password-resets`,
      { expectedVersion: 1, reason },
    );
    const token = new URLSearchParams(new URL(issued.body.data.link).hash.split('?')[1]).get(
      'token',
    );
    await f.db.database.client.adminPasswordReset.updateMany({
      where: { accountId: f.ordinary.account.id },
      data: { expiresAt: new Date(0) },
    });
    const body = { token, email: f.ordinary.account.email, password: 'new-expired-password-123' };
    for (let attempt = 0; attempt < 11; attempt++) {
      const response = await request(f.app.getHttpServer())
        .post('/api/admin/auth/password-resets/accept')
        .set('Origin', adminOrigin)
        .send(body);
      expect(response.status).toBe(attempt === 10 ? 429 : 400);
    }
    expect(
      (
        await f.db.database.client.adminAccount.findUniqueOrThrow({
          where: { id: f.ordinary.account.id },
        })
      ).passwordHash,
    ).toBe(f.ordinary.account.passwordHash);
  } finally {
    await f.close();
  }
});

it('edits and rotates invitations, invalidates old links and freezes consumed history', async () => {
  const f = await teamFixture();
  try {
    const created = await f.post(f.manager.cookie, '/team/invitations', {
      email: 'new@example.test',
      displayName: '新成员',
      roles: ['support'],
      reason,
    });
    const id = created.body.data.resourceId;
    const tokenFrom = (link: string) =>
      new URLSearchParams(new URL(link).hash.split('?')[1]).get('token');
    const accept = (token: string | null) =>
      request(f.app.getHttpServer())
        .post('/api/admin/auth/invitations/accept')
        .set('Origin', adminOrigin)
        .send({
          token,
          email: 'new@example.test',
          displayName: '本人设置姓名',
          password: 'invitation-password-123',
        });
    expect(
      (
        await f.call('patch', f.manager.cookie, `/team/invitations/${id}`, {
          expectedVersion: 1,
          reason,
          roles: ['finance'],
        })
      ).status,
    ).toBe(200);
    expect((await accept(tokenFrom(created.body.data.link))).status).toBe(401);
    const rotated = await f.post(f.manager.cookie, `/team/invitations/${id}/rotate`, {
      expectedVersion: 2,
      reason,
    });
    expect(rotated.status).toBe(201);
    expect((await accept(tokenFrom(rotated.body.data.link))).body.data.next).toBe('enroll');
    expect(
      (
        await f.post(f.manager.cookie, `/team/invitations/${id}/revoke`, {
          expectedVersion: 4,
          reason,
        })
      ).body.code,
    ).toBe('ADMIN_INVITATION_CONSUMED');
    const listed = await f.call('get', f.manager.cookie, '/team/invitations?q=new%40example.test');
    expect(listed.body.data.items).toHaveLength(1);
    expect(listed.body.data.items[0]).toMatchObject({
      status: 'consumed',
      roles: [{ key: 'finance' }],
    });
    expect(JSON.stringify(listed.body)).not.toContain('token');
  } finally {
    await f.close();
  }
});

it('issues a single-use reset without changing MFA or returning a session', async () => {
  const f = await teamFixture();
  try {
    const key = randomUUID(),
      body = { expectedVersion: 1, reason };
    const path = `/team/members/${f.ordinary.account.id}/password-resets`;
    const issued = await f.post(f.manager.cookie, path, body, key);
    expect(issued.status).toBe(201);
    expect((await f.call('get', f.ordinary.cookie, '/me')).status).toBe(401);
    expect((await f.post(f.manager.cookie, path, body, key)).body.data).toMatchObject({
      linkUnavailable: true,
      version: 2,
    });
    const token = new URLSearchParams(new URL(issued.body.data.link).hash.split('?')[1]).get(
      'token',
    );
    const reset = { token, email: f.ordinary.account.email, password: 'new-team-password-123' };
    const accept = (data: object) =>
      request(f.app.getHttpServer())
        .post('/api/admin/auth/password-resets/accept')
        .set('Origin', adminOrigin)
        .send(data);
    expect((await accept({ ...reset, email: 'wrong@example.test' })).status).toBe(400);
    const accepted = await accept(reset);
    expect(accepted.status).toBe(201);
    expect(accepted.body.data).toEqual({ success: true });
    expect(accepted.headers['set-cookie']).toBeUndefined();
    expect((await accept(reset)).status).toBe(400);
    const after = await f.db.database.client.adminAccount.findUniqueOrThrow({
      where: { id: f.ordinary.account.id },
    });
    expect(after.encryptedMfaSecret).toBe(f.ordinary.account.encryptedMfaSecret);
    expect(after.lastTotpCounter).toBe(f.ordinary.account.lastTotpCounter);
    expect(after.passwordHash).not.toBe(f.ordinary.account.passwordHash);
    expect(JSON.stringify(await f.db.database.client.adminCommandReceipt.findMany())).not.toContain(
      token,
    );
  } finally {
    await f.close();
  }
});

it('validates custom permission dependencies and prevents deleting roles in use', async () => {
  const f = await teamFixture();
  try {
    const body = {
      key: 'custom_business',
      name: '业务统计员',
      description: '岗位统计权限',
      permissions: [
        'dashboard.read',
        'dashboard.business.read',
        'users.read',
        'orders.read',
        'jobs.read',
      ],
      reason,
    };
    expect((await f.post(f.manager.cookie, '/team/roles', body)).status).toBe(403);
    expect(
      (
        await f.post(f.superAdmin.cookie, '/team/roles', {
          ...body,
          permissions: ['dashboard.read', 'dashboard.business.read'],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await f.post(f.superAdmin.cookie, '/team/roles', {
          ...body,
          permissions: ['dashboard.read', 'admins.create', 'admins.read'],
        })
      ).status,
    ).toBe(400);
    expect((await f.post(f.superAdmin.cookie, '/team/roles', body)).status).toBe(201);
    expect(
      (
        await f.call('put', f.manager.cookie, `/team/members/${f.ordinary.account.id}/roles`, {
          roles: [body.key],
          expectedVersion: 1,
          reason,
        })
      ).status,
    ).toBe(200);
    const detail = await f.call('get', f.superAdmin.cookie, `/team/roles/${body.key}`);
    expect(detail.body.data.memberCount).toBe(1);
    expect(
      detail.body.data.allowedActions.find(
        (action: { action: string }) => action.action === 'delete',
      ),
    ).toMatchObject({ allowed: false, reasonCode: 'ADMIN_ROLE_IN_USE' });
    expect(
      (
        await f.call('delete', f.superAdmin.cookie, `/team/roles/${body.key}`, {
          expectedVersion: 1,
          reason,
        })
      ).body.code,
    ).toBe('ADMIN_ROLE_IN_USE');
    expect(
      (
        await f.call('patch', f.superAdmin.cookie, '/team/roles/owner', {
          ...body,
          key: undefined,
          expectedVersion: 1,
        })
      ).body.code,
    ).toBe('ADMIN_BUILTIN_ROLE');
    const edited = await f.call('patch', f.superAdmin.cookie, `/team/roles/${body.key}`, {
      name: body.name,
      description: body.description,
      permissions: ['dashboard.read'],
      expectedVersion: 1,
      reason,
    });
    expect(edited.status).toBe(200);
    expect(
      (
        await f.db.database.client.adminAccount.findUniqueOrThrow({
          where: { id: f.ordinary.account.id },
        })
      ).version,
    ).toBe(3);
  } finally {
    await f.close();
  }
});
