import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { AdminAuthService } from '../../src/modules/admin/auth.service.js';
import { digest, token } from '../../src/modules/admin/crypto.js';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';
import { adminApp, adminConfig, adminOrigin, cookies } from '../helpers/admin.js';

describe('explicit local password-only administrator login', () => {
  let db: TestDatabase;
  let local: INestApplication;
  let mfaOnly: INestApplication;
  let ordinary: INestApplication;
  const emails: [string, string] = ['local-one@example.test', 'local-two@example.test'];
  const password = 'local-test-password-123';
  beforeAll(async () => {
    db = await createTestDatabase();
    const common = {
      nodeEnv: 'development',
      host: '127.0.0.1',
      admin: { ...adminConfig, localTestEmails: emails },
    };
    local = await adminApp(db, {
      ...common,
      admin: { ...common.admin, localPasswordLogin: true },
    });
    mfaOnly = await adminApp(db, common);
    ordinary = await adminApp(db);
  });
  afterAll(async () => {
    await local?.close();
    await mfaOnly?.close();
    await ordinary?.close();
    await db?.cleanup();
  });
  function post(app: INestApplication, path: string) {
    return request(app.getHttpServer()).post(`/api/admin/${path}`).set('Origin', adminOrigin);
  }
  function me(app: INestApplication, cookie: string) {
    return request(app.getHttpServer()).get('/api/admin/me').set('Cookie', cookie);
  }
  async function invite(email: string, app = mfaOnly, chosenPassword = password) {
    const raw = token();
    await db.database.client.adminInvitation.create({
      data: {
        email,
        tokenHash: digest(raw),
        roleBindings: { create: { roleKey: 'system_admin' } },
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
    return post(app, 'auth/invitations/accept').send({
      token: raw,
      email,
      displayName: 'Local operator',
      password: chosenPassword,
    });
  }
  it('logs an existing pending account in without MFA while preserving its enrollment state, roles and audit', async () => {
    const accepted = await invite(emails[0]);
    expect(accepted.body.data.next).toBe('enroll');
    const result = await post(local, 'auth/login').send({ email: emails[0], password });
    expect(result.status).toBe(201);
    expect(result.body.data.account?.email).toBe(emails[0]);
    expect(result.body.data).not.toHaveProperty('secret');
    expect(result.body.data).not.toHaveProperty('recoveryCodes');
    const sessionCookie = cookies(result);
    expect(sessionCookie).toContain('viviai_admin_session=');
    expect((await me(local, sessionCookie)).status).toBe(200);
    expect((await me(mfaOnly, sessionCookie)).status).toBe(401);
    expect((await me(ordinary, sessionCookie)).status).toBe(401);
    const account = await db.database.client.adminAccount.findUniqueOrThrow({
      where: { email: emails[0] },
    });
    expect(account.status).toBe('pending');
    expect(account.lastTotpCounter).toBeNull();
    expect(
      (
        await db.database.client.adminAccountRole.findMany({ where: { accountId: account.id } })
      ).map((b) => b.roleKey),
    ).toEqual(['system_admin']);
    expect(account.extraPermissions).toEqual([]);
    expect(
      await db.database.client.adminRecoveryCode.count({ where: { accountId: account.id } }),
    ).toBe(0);
    expect(
      await db.database.client.adminChallenge.count({ where: { accountId: account.id } }),
    ).toBe(0);
    expect(
      await db.database.client.adminAuditEvent.count({
        where: { accountId: account.id, action: 'auth.local_password', outcome: 'allowed' },
      }),
    ).toBe(1);
    expect(
      (await request(local.getHttpServer()).get('/api/admin/users').set('Cookie', sessionCookie))
        .status,
    ).toBe(403);
    const rawSession = sessionCookie.match(/viviai_admin_session=([^;]+)/)![1]!;
    await expect(
      local.get(AdminAuthService).resolve(rawSession, '203.0.113.7'),
    ).rejects.toMatchObject({ status: 401 });
    const remoteLogin = await local.get(AdminAuthService).login(emails[0], password, '203.0.113.7');
    expect(remoteLogin.data).toHaveProperty('next', 'enroll');
    await post(local, 'auth/logout').set('Cookie', sessionCookie).send({});
    expect((await me(local, sessionCookie)).status).toBe(401);
  });
  it('also completes an allowlisted invitation directly, but only with a correct password and enabled account', async () => {
    const accepted = await invite(emails[1], local, '123456');
    expect(accepted.status).toBe(201);
    expect(accepted.body.data.account?.email).toBe(emails[1]);
    expect((await me(local, cookies(accepted))).status).toBe(200);
    expect(
      (await post(local, 'auth/login').send({ email: emails[1], password: 'wrong-password-123' }))
        .status,
    ).toBe(401);
    await db.database.client.adminAccount.update({
      where: { email: emails[1] },
      data: { disabledAt: new Date() },
    });
    expect(
      (await post(local, 'auth/login').send({ email: emails[1], password: '123456' })).status,
    ).toBe(401);
    expect((await me(local, cookies(accepted))).status).toBe(401);
  });
  it('requires MFA for accounts outside the allowlist even when local password-only mode is on', async () => {
    const email = 'ordinary-admin@example.test';
    const accepted = await invite(email, local);
    expect(accepted.body.data.next).toBe('enroll');
    expect((await me(local, cookies(accepted))).status).toBe(401);
    const login = await post(local, 'auth/login').send({ email, password });
    expect(login.body.data.next).toBe('enroll');
    expect(login.body.data).not.toHaveProperty('account');
  });
  it('keeps local password sessions subject to idle expiry, auth-version revocation and allowlist removal', async () => {
    const auth = local.get(AdminAuthService);
    const account = await db.database.client.adminAccount.findUniqueOrThrow({
      where: { email: emails[0] },
    });
    const login = async () => {
      const result = await post(local, 'auth/login').send({ email: account.email, password });
      expect(result.status).toBe(201);
      const sessionCookie = cookies(result);
      expect((await me(local, sessionCookie)).status).toBe(200);
      return sessionCookie;
    };
    const idle = await login();
    await db.database.client.adminSession.updateMany({
      where: { accountId: account.id },
      data: { lastSeenAt: new Date(Date.now() - 31 * 60000) },
    });
    expect((await me(local, idle)).status).toBe(401);
    const revoked = await login();
    await db.database.client.adminAccount.update({
      where: { id: account.id },
      data: { authVersion: { increment: 1 } },
    });
    expect((await me(local, revoked)).status).toBe(401);
    const unlisted = await login();
    const previous = auth.config.admin!.localTestEmails!;
    try {
      auth.config.admin!.localTestEmails = [emails[1]];
      expect((await me(local, unlisted)).status).toBe(401);
    } finally {
      auth.config.admin!.localTestEmails = previous;
    }
  });
  it('advertises only the effective mode, without exposing the allowlist', async () => {
    const result = await request(local.getHttpServer()).get('/api/admin/status');
    expect(result.body.data.localPasswordLogin).toBe(true);
    expect(JSON.stringify(result.body)).not.toContain(emails[0]);
    expect(
      (await request(mfaOnly.getHttpServer()).get('/api/admin/status')).body.data
        .localPasswordLogin,
    ).toBeUndefined();
  });
});
