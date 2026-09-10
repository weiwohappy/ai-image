import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { AdminAuthService } from '../../src/modules/admin/auth.service.js';
import { digest, token } from '../../src/modules/admin/crypto.js';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';
import { adminApp, adminConfig, adminOrigin, cookies, currentCode } from '../helpers/admin.js';

describe('explicit local-only administrator password exception', () => {
  let db: TestDatabase;
  let local: INestApplication;
  let ordinary: INestApplication;
  beforeAll(async () => {
    db = await createTestDatabase();
    local = await adminApp(db, {
      nodeEnv: 'development',
      host: '127.0.0.1',
      admin: {
        ...adminConfig,
        localTestEmails: ['short-one@example.test', 'short-two@example.test'],
      },
    });
    ordinary = await adminApp(db);
  });
  afterAll(async () => {
    await local?.close();
    await ordinary?.close();
    await db?.cleanup();
  });
  function post(app: INestApplication, path: string) {
    return request(app.getHttpServer()).post(`/api/admin/${path}`).set('Origin', adminOrigin);
  }
  async function invitation(email: string) {
    const raw = token();
    await db.database.client.adminInvitation.create({
      data: {
        email,
        tokenHash: digest(raw),
        roleBindings: { create: { roleKey: 'system_admin' } },
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
    return { token: raw, email, displayName: 'Local test operator', password: '123456' };
  }
  it('accepts only an allowlisted local short password, still requires enrollment and MFA, and disables it when the exception is absent', async () => {
    const body = await invitation('short-one@example.test');
    const accepted = await post(local, 'auth/invitations/accept').send(body);
    expect(accepted.status).toBe(201);
    expect(accepted.body.data.next).toBe('enroll');
    expect(cookies(accepted)).not.toContain('viviai_admin_session=');
    expect(
      (await request(local.getHttpServer()).get('/api/admin/me').set('Cookie', cookies(accepted)))
        .status,
    ).toBe(401);
    expect(
      (
        await post(local, 'auth/mfa/verify')
          .set('Cookie', cookies(accepted))
          .send({ method: 'recovery', code: 'a'.repeat(32) })
      ).status,
    ).toBe(401);
    expect(
      (await post(ordinary, 'auth/login').send({ email: body.email, password: '123456' })).status,
    ).toBe(400);
    expect(
      (await post(local, 'auth/login').send({ email: body.email, password: '123457' })).status,
    ).toBe(401);
    const login = await post(local, 'auth/login').send({ email: body.email, password: '123456' });
    expect(login.body.data.next).toBe('enroll');
    const verified = await post(local, 'auth/mfa/verify')
      .set('Cookie', cookies(login))
      .send({ method: 'totp', code: currentCode(login.body.data.secret) });
    expect(verified.status).toBe(201);
    expect(verified.body.data.account.roles).toEqual(['system_admin']);
    expect(verified.body.data.account.permissions).not.toContain('users.read');
    expect(
      (await request(local.getHttpServer()).get('/api/admin/me').set('Cookie', cookies(verified)))
        .status,
    ).toBe(200);
  });
  it('rejects short passwords for other emails without consuming their invitation or creating an account', async () => {
    const body = await invitation('ordinary@example.test');
    expect((await post(local, 'auth/invitations/accept').send(body)).status).toBe(400);
    const invite = await db.database.client.adminInvitation.findUniqueOrThrow({
      where: { email: body.email },
    });
    expect(invite.consumedAt).toBeNull();
    expect(await db.database.client.adminAccount.count({ where: { email: body.email } })).toBe(0);
  });
  it('rejects non-loopback callers at the service boundary even for allowlisted accounts', async () => {
    const body = await invitation('short-two@example.test');
    const auth = local.get(AdminAuthService);
    await expect(auth.accept(body, '203.0.113.4')).rejects.toMatchObject({ status: 400 });
    await expect(auth.login(body.email, body.password, '203.0.113.4')).rejects.toMatchObject({
      status: 400,
    });
    expect(await db.database.client.adminAccount.count({ where: { email: body.email } })).toBe(0);
  });
  it('only advertises a local policy flag and never the allowlist or password', async () => {
    const result = await request(local.getHttpServer()).get('/api/admin/status');
    expect(result.body.data.localTestPasswords).toBe(true);
    expect(JSON.stringify(result.body)).not.toContain('short-one');
    expect(JSON.stringify(result.body)).not.toContain('123456');
    expect(
      (await request(ordinary.getHttpServer()).get('/api/admin/status')).body.data
        .localTestPasswords,
    ).toBeUndefined();
  });
});
