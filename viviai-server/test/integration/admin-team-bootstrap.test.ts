import { expect, it } from 'vitest';
import { createTestDatabase } from '../helpers/database.js';
import { adminConfig, fixtureAdmin } from '../helpers/admin.js';
import { loadConfig } from '../../src/config.js';
import { bootstrapSuperAdministrator } from '../../src/modules/admin/team/bootstrap-super-admin.js';
const config = () => ({
  ...loadConfig(),
  nodeEnv: 'development' as const,
  host: '127.0.0.1',
  admin: adminConfig,
});
it('dry-runs and applies first-super promotion without changing credentials or existing grants', async () => {
  const db = await createTestDatabase();
  try {
    const target = await fixtureAdmin(db, ['owner', 'system_admin'], ['sensitive.read']);
    const input = {
      email: target.account.email,
      expectedVersion: 1,
      reason: '批准初次建立超级管理员',
      apply: false,
    };
    const dry = await bootstrapSuperAdministrator(db.database, config(), input);
    expect(dry).toMatchObject({ accountId: target.account.id, applied: false, version: 1 });
    expect(
      await db.database.client.adminAccountRole.count({ where: { roleKey: 'super_admin' } }),
    ).toBe(0);
    expect(await db.database.client.adminAuditEvent.count()).toBe(0);
    const applied = await bootstrapSuperAdministrator(db.database, config(), {
      ...input,
      apply: true,
    });
    expect(applied).toMatchObject({
      applied: true,
      version: 2,
      roles: ['owner', 'super_admin', 'system_admin'],
    });
    const saved = await db.database.client.adminAccount.findUniqueOrThrow({
      where: { id: target.account.id },
    });
    expect(saved.passwordHash).toBe(target.account.passwordHash);
    expect(saved.encryptedMfaSecret).toBe(target.account.encryptedMfaSecret);
    expect(saved.extraPermissions).toEqual(['sensitive.read']);
    expect(saved.authVersion).toBe(2);
    expect(
      (
        await db.database.client.adminSession.findUniqueOrThrow({
          where: { id: target.session.id },
        })
      ).expiresAt.getTime(),
    ).toBe(0);
    const event = await db.database.client.adminAuditEvent.findFirstOrThrow({
      where: { action: 'team.super.bootstrap' },
    });
    expect(event.accountId).toBeNull();
    await expect(
      bootstrapSuperAdministrator(db.database, config(), {
        ...input,
        expectedVersion: 2,
        apply: true,
      }),
    ).rejects.toThrow();
  } finally {
    await db.cleanup();
  }
});
it('rejects pending non-exempt, stale, nonlocal and non-normalized promotion inputs', async () => {
  const db = await createTestDatabase();
  try {
    const target = await fixtureAdmin(db, ['support']);
    const input = {
      email: target.account.email,
      expectedVersion: 1,
      reason: '批准初次建立超级管理员',
      apply: true,
    };
    await expect(
      bootstrapSuperAdministrator(db.database, config(), {
        ...input,
        email: input.email.toUpperCase(),
      }),
    ).rejects.toThrow();
    await expect(
      bootstrapSuperAdministrator(db.database, { ...config(), nodeEnv: 'test' }, input),
    ).rejects.toThrow();
    await expect(
      bootstrapSuperAdministrator(db.database, config(), { ...input, expectedVersion: 2 }),
    ).rejects.toThrow();
    await db.database.client.adminAccount.update({
      where: { id: target.account.id },
      data: { status: 'pending', lastTotpCounter: null },
    });
    await expect(bootstrapSuperAdministrator(db.database, config(), input)).rejects.toThrow();
    const local = {
      ...config(),
      admin: { ...adminConfig, localPasswordLogin: true, localTestEmails: [input.email] },
    };
    expect((await bootstrapSuperAdministrator(db.database, local, input)).applied).toBe(true);
    expect(
      (
        await db.database.client.adminAccount.findUniqueOrThrow({
          where: { id: target.account.id },
        })
      ).status,
    ).toBe('pending');
  } finally {
    await db.cleanup();
  }
});
