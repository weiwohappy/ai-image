import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { expect, it } from 'vitest';
import { ROLE_PERMISSIONS } from '../src/modules/admin/permission-catalog.js';
import { fixtureAdmin } from './helpers/admin.js';
import { createTestDatabase } from './helpers/database.js';

it('migrates content permissions additively and invalidates only affected administrator sessions', async () => {
  const db = await createTestDatabase({
    migrateThrough: '20260912021000_content_catalog_metadata',
  });
  const schema = new URL(db.url).searchParams.get('schema')!;
  if (!/^viviai_test_[a-f0-9]+$/.test(schema)) throw new Error('Only owned test schemas');
  const sql = new pg.Client({ connectionString: db.url });
  await sql.connect();
  try {
    await sql.query(`SET search_path TO "${schema}"`);
    const superAdmin = await fixtureAdmin(db, ['super_admin']);
    const operator = await fixtureAdmin(db, ['content_operator']);
    const support = await fixtureAdmin(db, ['support']);
    const before = await db.database.client.adminRole.findMany({ orderBy: { key: 'asc' } });
    await sql.query(
      await readFile(
        new URL(
          '../prisma/migrations/20260912022000_admin_content_permissions/migration.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    await sql.query(
      await readFile(
        new URL(
          '../prisma/migrations/20260912050000_content_alert_permissions/migration.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const after = await db.database.client.adminRole.findMany({ orderBy: { key: 'asc' } });
    for (const role of after) {
      const permissionsAtThisMigration = ROLE_PERMISSIONS[role.key]!.filter(
        (permission) =>
          !['redemptions.read', 'redemptions.write', 'referrals.read'].includes(permission),
      );
      expect([...role.permissions].sort()).toEqual([...permissionsAtThisMigration].sort());
      const previous = before.find((candidate) => candidate.key === role.key)!;
      expect(role.version).toBe(
        ['super_admin', 'content_operator'].includes(role.key)
          ? previous.version + 2
          : previous.version,
      );
    }
    for (const admin of [superAdmin, operator, support]) {
      const affected = admin !== support;
      const account = await db.database.client.adminAccount.findUniqueOrThrow({
        where: { id: admin.account.id },
      });
      expect(account.authVersion).toBe(affected ? 3 : 1);
      expect(
        (
          await db.database.client.adminSession.findUniqueOrThrow({
            where: { id: admin.session.id },
          })
        ).expiresAt.getTime() < Date.now(),
      ).toBe(affected);
    }
  } finally {
    await sql.end();
    await db.cleanup();
  }
});
