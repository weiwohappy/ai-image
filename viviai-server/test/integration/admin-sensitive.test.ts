import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';
import { createTestStorage } from '../helpers/storage.js';
import { adminApp, adminOrigin, fixtureAdmin, fixtureJob } from '../helpers/admin.js';
describe('audited sensitive access', () => {
  let db: TestDatabase;
  let app: INestApplication;
  let storage: Awaited<ReturnType<typeof createTestStorage>>;
  let admin: Awaited<ReturnType<typeof fixtureAdmin>>;
  let other: Awaited<ReturnType<typeof fixtureAdmin>>;
  let job: Awaited<ReturnType<typeof fixtureJob>>;
  let assetId: string;
  beforeAll(async () => {
    db = await createTestDatabase();
    storage = await createTestStorage();
    app = await adminApp(db, { localStorageRoot: storage.root });
    admin = await fixtureAdmin(db, ['support'], ['sensitive.read']);
    other = await fixtureAdmin(db, ['owner']);
    job = await fixtureJob(db);
    const asset = await db.database.client.asset.create({
      data: {
        userId: job.userId,
        name: 'private',
        objectKey: 'test/private.png',
        width: 12,
        height: 13,
        byteSize: 4,
        contentType: 'image/png',
      },
    });
    assetId = asset.id;
    await db.database.client.assetPin.create({
      data: { jobId: job.id, assetId, role: 'reference', snapshot: {} },
    });
    await storage.store.put('test/private.png', Buffer.from([137, 80, 78, 71]), 'image/png');
  });
  afterAll(async () => {
    await app?.close();
    await db?.cleanup();
    await storage?.cleanup();
  });
  const grant = (cookie = admin.cookie, reason = 'Investigate customer support case 123') =>
    request(app.getHttpServer())
      .post('/api/admin/sensitive-access-grants')
      .set('Origin', adminOrigin)
      .set('Cookie', cookie)
      .send({ jobId: job.id, reason });
  const get = (path: string, cookie = admin.cookie) =>
    request(app.getHttpServer()).get(`/api/admin/${path}`).set('Cookie', cookie);
  it('requires explicit sensitive permission and rejects credential-like reasons', async () => {
    expect((await grant(other.cookie)).status).toBe(403);
    expect(
      await db.database.client.adminAuditEvent.count({
        where: { accountId: other.account.id, action: 'sensitive.grant', outcome: 'denied' },
      }),
    ).toBe(1);
    expect((await grant(admin.cookie, 'password=please-do-not-store-secret')).status).toBe(400);
    expect((await grant(admin.cookie, 'short')).status).toBe(400);
  });
  it('audits grant and each use, streams only related stored bytes with no-store', async () => {
    const response = await grant();
    expect(response.status).toBe(201);
    const grantId = response.body.data.id;
    const saved = await db.database.client.adminSensitiveGrant.findUnique({
      where: { id: grantId },
    });
    expect(saved?.reason).toBe('Investigate customer support case 123');
    const sensitive = await get(`jobs/${job.id}/sensitive?grantId=${grantId}`);
    expect(sensitive.status).toBe(200);
    expect(sensitive.body.data.prompt).toBe('customer-private-prompt');
    expect(sensitive.body.data.assets[0].previewPath).toBe(
      `/api/admin/assets/${assetId}/preview?grantId=${grantId}`,
    );
    const preview = await get(`assets/${assetId}/preview?grantId=${grantId}`);
    expect(preview.status).toBe(200);
    expect(preview.headers['cache-control']).toBe('no-store');
    expect(preview.body).toEqual(Buffer.from([137, 80, 78, 71]));
    const audits = await db.database.client.adminAuditEvent.findMany({
      where: { accountId: admin.account.id },
    });
    expect(audits.filter((a) => a.action.startsWith('sensitive.'))).toHaveLength(3);
    expect(JSON.stringify(audits)).not.toContain('customer-private-prompt');
    const detail = await get(`jobs/${job.id}`);
    expect(detail.status).toBe(200);
    expect(JSON.stringify(detail.body)).not.toContain('customer-private-prompt');
    expect(JSON.stringify(detail.body)).not.toContain('private-request-hash');
  });
  it('rejects other sessions/jobs/assets, expired grants and deleted assets', async () => {
    const grantId = (await grant()).body.data.id;
    const foreign = await fixtureJob(db);
    expect((await get(`jobs/${foreign.id}/sensitive?grantId=${grantId}`)).status).toBe(404);
    const different = await fixtureAdmin(db, ['support'], ['sensitive.read']);
    expect(
      (await get(`jobs/${job.id}/sensitive?grantId=${grantId}`, different.cookie)).status,
    ).toBe(404);
    const unrelated = await db.database.client.asset.create({
      data: {
        userId: job.userId,
        name: 'unrelated',
        objectKey: 'not-pinned',
        width: 1,
        height: 1,
        byteSize: 1,
        contentType: 'image/png',
      },
    });
    expect((await get(`assets/${unrelated.id}/preview?grantId=${grantId}`)).status).toBe(404);
    await db.database.client.asset.update({
      where: { id: assetId },
      data: { deletedAt: new Date() },
    });
    expect((await get(`assets/${assetId}/preview?grantId=${grantId}`)).status).toBe(404);
    await db.database.client.asset.update({ where: { id: assetId }, data: { deletedAt: null } });
    await db.database.client.adminSensitiveGrant.update({
      where: { id: grantId },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    expect((await get(`jobs/${job.id}/sensitive?grantId=${grantId}`)).status).toBe(404);
  });
  it('retains the readable authorization reason after logout while revoking access', async () => {
    const temporary = await fixtureAdmin(db, ['support'], ['sensitive.read']);
    const grantId = (await grant(temporary.cookie)).body.data.id;
    const logout = await request(app.getHttpServer())
      .post('/api/admin/auth/logout')
      .set('Origin', adminOrigin)
      .set('Cookie', temporary.cookie)
      .send({});
    expect(logout.status).toBe(201);
    expect(
      (await get(`jobs/${job.id}/sensitive?grantId=${grantId}`, temporary.cookie)).status,
    ).toBe(401);
    expect(
      (await db.database.client.adminSensitiveGrant.findUnique({ where: { id: grantId } }))?.reason,
    ).toBe('Investigate customer support case 123');
  });
  it('fails closed on audit failure and role revocation, without issuing a grant', async () => {
    const before = await db.database.client.adminSensitiveGrant.count();
    const schema = new URL(db.url).searchParams.get('schema')!;
    await db.database.transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('search_path',${schema},true)`;
      await tx.$executeRawUnsafe(
        `CREATE FUNCTION test_reject_grant_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='sensitive.grant' THEN RAISE EXCEPTION 'Test audit storage failure'; END IF; RETURN NEW; END $$`,
      );
      await tx.$executeRawUnsafe(
        `CREATE TRIGGER test_reject_grant_audit BEFORE INSERT ON "AdminAuditEvent" FOR EACH ROW EXECUTE FUNCTION test_reject_grant_audit()`,
      );
    });
    expect((await grant()).status).toBe(500);
    await db.database.transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('search_path',${schema},true)`;
      await tx.$executeRawUnsafe(`DROP TRIGGER test_reject_grant_audit ON "AdminAuditEvent"`);
      await tx.$executeRawUnsafe(`DROP FUNCTION test_reject_grant_audit()`);
    });
    expect(await db.database.client.adminSensitiveGrant.count()).toBe(before);
    const grantId = (await grant()).body.data.id;
    await db.database.client.adminAccount.update({
      where: { id: admin.account.id },
      data: { extraPermissions: [] },
    });
    expect((await get(`jobs/${job.id}/sensitive?grantId=${grantId}`)).status).toBe(403);
  });
});
