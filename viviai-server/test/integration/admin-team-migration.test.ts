import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, it } from 'vitest';
import { createTestDatabase } from '../helpers/database.js';
const migration = new URL(
  '../../prisma/migrations/20260910030000_admin_team_management/migration.sql',
  import.meta.url,
);
async function legacy() {
  const db = await createTestDatabase({
    migrateThrough: '20260910020000_admin_local_password_login',
  });
  const schema = new URL(db.url).searchParams.get('schema')!;
  if (!/^viviai_test_[a-f0-9]+$/.test(schema))
    throw new Error('Only an owned test schema is permitted');
  const sql = new pg.Client({ connectionString: db.url });
  await sql.connect();
  await sql.query(`SET search_path TO "${schema}"`);
  return {
    db,
    sql,
    close: async () => {
      await sql.end();
      await db.cleanup();
    },
  };
}
it('migrates all legacy grants and restores disabled activation only with MFA evidence', async () => {
  const f = await legacy();
  try {
    const active = randomUUID(),
      pending = randomUUID(),
      invitation = randomUUID();
    await f.sql.query(
      'INSERT INTO "AdminAccount" (id,email,"displayName","passwordHash",status,roles,"extraPermissions","encryptedMfaSecret","lastTotpCounter") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9),($10,$11,$3,$4,$5,$6,$7,$8,NULL)',
      [
        active,
        'active@example.test',
        '姓名',
        'preserve-hash',
        'disabled',
        ['owner', 'system_admin'],
        ['sensitive.read'],
        'preserve-mfa',
        123,
        pending,
        'pending@example.test',
      ],
    );
    await f.sql.query(
      'INSERT INTO "AdminInvitation" (id,email,"tokenHash",roles,"expiresAt") VALUES ($1,$2,$3,$4,NOW()+INTERVAL \'1 day\')',
      [invitation, 'invite@example.test', 'preserve-token-hash', ['support']],
    );
    await f.sql.query(await readFile(migration, 'utf8'));
    const migrated = await f.db.database.client.adminAccount.findUniqueOrThrow({
      where: { id: active },
      include: { roleBindings: true },
    });
    expect(migrated.roleBindings.map((b) => b.roleKey).sort()).toEqual(['owner', 'system_admin']);
    expect(migrated).toMatchObject({
      status: 'active',
      passwordHash: 'preserve-hash',
      encryptedMfaSecret: 'preserve-mfa',
      extraPermissions: ['sensitive.read'],
      version: 1,
    });
    expect(migrated.disabledAt).toBeInstanceOf(Date);
    expect(
      (await f.db.database.client.adminAccount.findUniqueOrThrow({ where: { id: pending } }))
        .status,
    ).toBe('pending');
    expect(
      (
        await f.db.database.client.adminInvitation.findUniqueOrThrow({
          where: { id: invitation },
          include: { roleBindings: true },
        })
      ).roleBindings.map((b) => b.roleKey),
    ).toEqual(['support']);
    expect(
      (
        await f.sql.query(
          "SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='AdminAccount' AND column_name='roles'",
        )
      ).rowCount,
    ).toBe(0);
  } finally {
    await f.close();
  }
});
it('rolls back unknown legacy roles without removing the arrays', async () => {
  const f = await legacy();
  try {
    const id = randomUUID();
    await f.sql.query('ALTER TABLE "AdminAccount" DROP CONSTRAINT admin_roles');
    await f.sql.query(
      'INSERT INTO "AdminAccount" (id,email,"displayName","passwordHash",roles,"encryptedMfaSecret") VALUES ($1,$2,$3,$4,$5,$6)',
      [id, 'unknown@example.test', '旧记录', 'old-hash', ['future_role'], 'old-secret'],
    );
    await expect(f.sql.query(await readFile(migration, 'utf8'))).rejects.toThrow(id);
    await f.sql.query('ROLLBACK');
    expect(
      (await f.sql.query('SELECT roles FROM "AdminAccount" WHERE id=$1', [id])).rows[0].roles,
    ).toEqual(['future_role']);
    expect(
      (await f.sql.query('SELECT to_regclass(\'"AdminRole"\') AS role')).rows[0].role,
    ).toBeNull();
  } finally {
    await f.close();
  }
});
