import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, it } from 'vitest';
import { createTestDatabase } from './helpers/database.js';
import { fixtureAdmin } from './helpers/admin.js';
import { ROLE_PERMISSIONS } from '../src/modules/admin/permission-catalog.js';

it('additively migrates only super permission, invalidates affected grants, preserves credentials and historic amounts', async () => {
  const db = await createTestDatabase({ migrateThrough: '20260910030000_admin_team_management' });
  const schema = new URL(db.url).searchParams.get('schema')!;
  if (!/^viviai_test_[a-f0-9]+$/.test(schema)) throw new Error('Only owned test schemas');
  const sql = new pg.Client({ connectionString: db.url });
  await sql.connect();
  try {
    await sql.query(`SET search_path TO "${schema}"`);
    const superAdmin = await fixtureAdmin(db, ['super_admin'], ['sensitive.read']);
    const owner = await fixtureAdmin(db, ['owner']);
    const userId = randomUUID(),
      quoteId = randomUUID(),
      jobId = randomUUID();
    await sql.query('INSERT INTO users (id,email,username,password_hash) VALUES ($1,$2,$3,$4)', [
      userId,
      `${userId}@test.local`,
      userId,
      'unused',
    ]);
    await db.database.client.generationQuote.create({
      data: {
        id: quoteId,
        userId,
        input: { old: true },
        execution: { unitCredits: 123, channelId: 'legacy-channel' },
        inputHash: 'old',
        productVersion: 'gpt-image-2',
        unitCredits: 123n,
        totalCredits: 123n,
        expiresAt: new Date(Date.now() + 60000),
      },
      select: { id: true },
    });
    await db.database.client.generationJob.create({
      data: {
        id: jobId,
        userId,
        quoteId,
        operation: 'create',
        idempotencyKey: randomUUID(),
        requestHash: 'old',
        input: { old: true },
        execution: { unitCredits: 123, channelId: 'legacy-channel' },
        queueDeadlineAt: new Date(),
        deliveryDeadlineAt: new Date(),
        items: { create: { ordinal: 0, unitCredits: 123n, status: 'failed' } },
      },
      select: { id: true },
    });
    for (const admin of [superAdmin, owner]) {
      await db.database.client.adminChallenge.create({
        data: {
          accountId: admin.account.id,
          tokenHash: randomUUID(),
          authVersion: 1,
          expiresAt: new Date(Date.now() + 60000),
        },
      });
      await db.database.client.adminSensitiveGrant.create({
        data: {
          accountId: admin.account.id,
          sessionId: admin.session.id,
          jobId,
          reasonDigest: 'test',
          reason: 'migration test reason',
          expiresAt: new Date(Date.now() + 60000),
        },
      });
      await db.database.client.adminPasswordReset.create({
        data: {
          accountId: admin.account.id,
          tokenHash: randomUUID(),
          createdBy: admin.account.id,
          expiresAt: new Date(Date.now() + 60000),
        },
      });
    }
    const rolesBefore = await db.database.client.adminRole.findMany({ orderBy: { key: 'asc' } });
    await sql.query(
      await readFile(
        new URL(
          '../prisma/migrations/20260910040000_model_credit_pricing/migration.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const rolesAfter = await db.database.client.adminRole.findMany({ orderBy: { key: 'asc' } });
    for (const role of rolesAfter) {
      const permissionsAtThisMigration = ROLE_PERMISSIONS[role.key]!.filter(
        (permission) =>
          !permission.startsWith('content.') &&
          !['redemptions.read', 'redemptions.write', 'referrals.read'].includes(permission) &&
          permission !== 'alerts.content.read' &&
          !(role.key === 'content_operator' && permission === 'alerts.read'),
      );
      expect([...role.permissions].sort()).toEqual([...permissionsAtThisMigration].sort());
      if (role.key === 'super_admin') expect(role.version).toBe(2);
      else expect(role).toEqual(rolesBefore.find((r) => r.key === role.key));
    }
    for (const admin of [superAdmin, owner]) {
      const changed = admin === superAdmin;
      const after = await db.database.client.adminAccount.findUniqueOrThrow({
        where: { id: admin.account.id },
        include: { roleBindings: true },
      });
      expect(after).toMatchObject({
        passwordHash: admin.account.passwordHash,
        encryptedMfaSecret: admin.account.encryptedMfaSecret,
        lastTotpCounter: admin.account.lastTotpCounter,
        extraPermissions: admin.account.extraPermissions,
        status: admin.account.status,
        authVersion: changed ? 2 : 1,
        version: changed ? 2 : 1,
      });
      expect(after.roleBindings.map((b) => b.roleKey)).toEqual(
        changed ? ['super_admin'] : ['owner'],
      );
      const expiresAt = (
        await db.database.client.adminSession.findUniqueOrThrow({ where: { id: admin.session.id } })
      ).expiresAt.getTime();
      if (changed) expect(expiresAt).toBeLessThan(Date.now());
      else expect(expiresAt).toBe(admin.session.expiresAt.getTime());
      expect(
        await db.database.client.adminChallenge.count({ where: { accountId: admin.account.id } }),
      ).toBe(changed ? 0 : 1);
      expect(
        await db.database.client.adminSensitiveGrant.count({
          where: { accountId: admin.account.id },
        }),
      ).toBe(changed ? 0 : 1);
      expect(
        (
          await db.database.client.adminPasswordReset.findFirstOrThrow({
            where: { accountId: admin.account.id },
          })
        ).revokedAt !== null,
      ).toBe(changed);
    }
    expect(await db.database.client.modelCreditPrice.count()).toBe(0);
    expect(
      await db.database.client.generationQuote.findUniqueOrThrow({ where: { id: quoteId } }),
    ).toMatchObject({
      creditPriceSnapshot: null,
      unitCredits: 123n,
      totalCredits: 123n,
      execution: { unitCredits: 123, channelId: 'legacy-channel' },
    });
    const job = await db.database.client.generationJob.findUniqueOrThrow({
      where: { id: jobId },
      include: { items: true },
    });
    expect(job.creditPriceSnapshot).toBeNull();
    expect(job.items[0]).toMatchObject({ unitCredits: 123n, status: 'failed' });
    for (const unitCredits of [0, -1, 1000001])
      await expect(
        db.database.client.modelCreditPrice.create({
          data: { modelId: 'gpt-image-2', resolution: '1K', unitCredits, enabled: true },
        }),
      ).rejects.toThrow();
    await expect(
      db.database.client.modelCreditPrice.create({
        data: { modelId: '', resolution: '1K', unitCredits: 100, enabled: true },
      }),
    ).rejects.toThrow();
    await expect(
      db.database.client.modelCreditPrice.create({
        data: {
          modelId: 'gpt-image-2',
          resolution: '1K',
          unitCredits: 100,
          enabled: true,
          version: 0,
        },
      }),
    ).rejects.toThrow();
  } finally {
    await sql.end();
    await db.cleanup();
  }
});
