import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../../src/main.js';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';
import { adminApp, adminOrigin, fixtureAdmin, cookies, currentCode } from '../helpers/admin.js';
import { digest, token } from '../../src/modules/admin/crypto.js';
import { bootstrapAdministrators, revokeAdministrator } from '../../src/modules/admin/bootstrap.js';

describe('isolated admin HTTP boundary', () => {
  let db: TestDatabase;
  let app: INestApplication;
  beforeAll(async () => {
    db = await createTestDatabase();
    app = await createApp({ databaseUrl: db.url, nodeEnv: 'test' });
  });
  afterAll(async () => {
    await app?.close();
    await db?.cleanup();
  });
  it('publishes only disabled stage status by default', async () => {
    const response = await request(app.getHttpServer()).get('/api/admin/status');
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ enabled: false, environment: 'test', stage: 'A' });
  });
  it('does not let a consumer cookie authorize admin queries', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/admin/users')
      .set('Cookie', 'viviai_session=consumer-token');
    expect(response.status).toBe(401);
  });
});

describe('admin invitation and MFA', () => {
  let db: TestDatabase;
  let app: INestApplication;
  beforeAll(async () => {
    db = await createTestDatabase();
    app = await adminApp(db);
  });
  afterAll(async () => {
    await app?.close();
    await db?.cleanup();
  });
  const post = (path: string) =>
    request(app.getHttpServer()).post(`/api/admin/${path}`).set('Origin', adminOrigin);
  it('requires a separate allowed Origin even for login and rejects unknown body fields', async () => {
    expect(
      (
        await request(app.getHttpServer())
          .post('/api/admin/auth/login')
          .set('Origin', 'http://localhost:3000')
          .send({})
      ).status,
    ).toBe(403);
    expect(
      (
        await post('auth/login').send({
          email: 'x@example.test',
          password: 'test-only-long-password',
          role: 'owner',
        })
      ).status,
    ).toBe(400);
  });
  it('binds invitations, resumes enrollment, returns recovery codes once, and rejects TOTP replay', async () => {
    const raw = token();
    const email = 'invite@example.test';
    await db.database.client.adminInvitation.create({
      data: {
        tokenHash: digest(raw),
        email,
        roles: ['support'],
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
    expect(
      (
        await post('auth/invitations/accept').send({
          token: raw,
          email: 'wrong@example.test',
          displayName: 'Test',
          password: 'test-only-long-password',
        })
      ).status,
    ).toBe(401);
    const accepted = await post('auth/invitations/accept').send({
      token: raw,
      email,
      displayName: 'Test',
      password: 'test-only-long-password',
    });
    expect(accepted.status).toBe(201);
    expect(accepted.body.data.next).toBe('enroll');
    expect(
      (await request(app.getHttpServer()).get('/api/admin/users').set('Cookie', cookies(accepted)))
        .status,
    ).toBe(401);
    expect(
      (
        await post('auth/invitations/accept').send({
          token: raw,
          email,
          displayName: 'Test',
          password: 'test-only-long-password',
        })
      ).status,
    ).toBe(401);
    const resumed = await post('auth/login').send({ email, password: 'test-only-long-password' });
    expect(resumed.body.data.secret).toBe(accepted.body.data.secret);
    const verified = await post('auth/mfa/verify')
      .set('Cookie', cookies(resumed))
      .send({ method: 'totp', code: currentCode(resumed.body.data.secret) });
    expect(verified.status).toBe(201);
    expect(verified.body.data.recoveryCodes).toHaveLength(8);
    expect(verified.body.data.account.permissions).not.toContain('costs.read');
    expect(
      (await request(app.getHttpServer()).get('/api/admin/me').set('Cookie', cookies(verified)))
        .status,
    ).toBe(200);
    const login = await post('auth/login').send({ email, password: 'test-only-long-password' });
    expect(login.body.data).not.toHaveProperty('secret');
    expect(login.body.data.next).toBe('mfa');
    expect(
      (
        await post('auth/mfa/verify')
          .set('Cookie', cookies(login))
          .send({ method: 'totp', code: currentCode(resumed.body.data.secret) })
      ).status,
    ).toBe(401);
    const recovery = verified.body.data.recoveryCodes[0];
    const outcomes = await Promise.all(
      [1, 2].map(() =>
        post('auth/mfa/verify')
          .set('Cookie', cookies(login))
          .send({ method: 'recovery', code: recovery }),
      ),
    );
    expect(outcomes.map((r) => r.status).sort()).toEqual([201, 401]);
    expect(outcomes.find((r) => r.status === 201)!.body.data).not.toHaveProperty('recoveryCodes');
  });
  it('commits five failed MFA attempts, then refuses the correct code', async () => {
    const admin = await fixtureAdmin(db);
    const login = await post('auth/login').send({
      email: admin.account.email,
      password: 'test-only-long-password',
    });
    for (let i = 0; i < 5; i++)
      expect(
        (
          await post('auth/mfa/verify')
            .set('Cookie', cookies(login))
            .send({ method: 'totp', code: 'abcdef' })
        ).status,
      ).toBe(401);
    expect(
      (
        await post('auth/mfa/verify')
          .set('Cookie', cookies(login))
          .send({ method: 'totp', code: currentCode() })
      ).status,
    ).toBe(401);
    const challenge = await db.database.client.adminChallenge.findFirst({
      where: { accountId: admin.account.id },
    });
    expect(challenge?.attempts).toBe(5);
    expect(
      await db.database.client.adminAuditEvent.count({
        where: { accountId: admin.account.id, action: 'mfa.verify', outcome: 'denied' },
      }),
    ).toBeGreaterThanOrEqual(5);
  });
  it('checks session idle/absolute expiry and account revocation on each request', async () => {
    const admin = await fixtureAdmin(db);
    const me = () => request(app.getHttpServer()).get('/api/admin/me').set('Cookie', admin.cookie);
    expect((await me()).status).toBe(200);
    await db.database.client.adminSession.update({
      where: { id: admin.session.id },
      data: { lastSeenAt: new Date(Date.now() - 31 * 60000) },
    });
    expect((await me()).status).toBe(401);
    await db.database.client.adminSession.update({
      where: { id: admin.session.id },
      data: { lastSeenAt: new Date(), expiresAt: new Date(Date.now() - 1) },
    });
    expect((await me()).status).toBe(401);
    await db.database.client.adminSession.update({
      where: { id: admin.session.id },
      data: { expiresAt: new Date(Date.now() + 60000) },
    });
    await db.database.client.adminAccount.update({
      where: { id: admin.account.id },
      data: { authVersion: 2 },
    });
    expect((await me()).status).toBe(401);
  });
  it('rejects audit mutation in SQL', async () => {
    const audit = await db.database.client.adminAuditEvent.create({
      data: { action: 'test', outcome: 'ok' },
    });
    await expect(
      db.database.client.adminAuditEvent.update({
        where: { id: audit.id },
        data: { outcome: 'altered' },
      }),
    ).rejects.toThrow();
    await expect(
      db.database.client.adminAuditEvent.delete({ where: { id: audit.id } }),
    ).rejects.toThrow();
  });
  it('does not accept a genuine consumer session in an enabled administrator deployment', async () => {
    const raw = token();
    const user = await db.database.client.user.create({
      data: {
        email: 'customer-private@example.test',
        username: 'customer-private',
        passwordHash: 'private',
      },
    });
    await db.database.client.session.create({
      data: { userId: user.id, tokenHash: digest(raw), expiresAt: new Date(Date.now() + 60000) },
    });
    const response = await request(app.getHttpServer())
      .get('/api/admin/users')
      .set('Cookie', `viviai_session=${raw}`);
    expect(response.status).toBe(401);
    expect(JSON.stringify(response.body)).not.toContain('customer-private@example.test');
  });
  it('expires invitations and challenges without issuing an account or session', async () => {
    const raw = token();
    await db.database.client.adminInvitation.create({
      data: {
        tokenHash: digest(raw),
        email: 'expired@example.test',
        roles: ['owner'],
        expiresAt: new Date(Date.now() - 1),
      },
    });
    expect(
      (
        await post('auth/invitations/accept').send({
          token: raw,
          email: 'expired@example.test',
          displayName: 'Expired',
          password: 'test-only-long-password',
        })
      ).status,
    ).toBe(401);
    expect(
      await db.database.client.adminAccount.count({ where: { email: 'expired@example.test' } }),
    ).toBe(0);
    const admin = await fixtureAdmin(db);
    const login = await post('auth/login').send({
      email: admin.account.email,
      password: 'test-only-long-password',
    });
    await db.database.client.adminChallenge.updateMany({
      where: { accountId: admin.account.id },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    expect(
      (
        await post('auth/mfa/verify')
          .set('Cookie', cookies(login))
          .send({ method: 'totp', code: currentCode() })
      ).status,
    ).toBe(401);
  });
  it('concurrently accepts one TOTP once and logout revokes the issued session', async () => {
    const admin = await fixtureAdmin(db);
    const logins = await Promise.all(
      [1, 2].map(() =>
        post('auth/login').send({
          email: admin.account.email,
          password: 'test-only-long-password',
        }),
      ),
    );
    const code = currentCode();
    const results = await Promise.all(
      logins.map((login) =>
        post('auth/mfa/verify').set('Cookie', cookies(login)).send({ method: 'totp', code }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 401]);
    const sessionCookie = cookies(results.find((r) => r.status === 201)!);
    const logout = await post('auth/logout').set('Cookie', sessionCookie).send({});
    expect(logout.status).toBe(201);
    expect(
      (await request(app.getHttpServer()).get('/api/admin/me').set('Cookie', sessionCookie)).status,
    ).toBe(401);
  });
  it('persists per-credential login rate limits across requests', async () => {
    for (let i = 0; i < 10; i++)
      expect(
        (
          await post('auth/login').send({
            email: 'missing-rate@example.test',
            password: 'test-only-long-password',
          })
        ).status,
      ).toBe(401);
    expect(
      (
        await post('auth/login').send({
          email: 'missing-rate@example.test',
          password: 'test-only-long-password',
        })
      ).status,
    ).toBe(429);
    expect(
      (
        await post('auth/login').send({
          email: 'other-rate@example.test',
          password: 'test-only-long-password',
        })
      ).status,
    ).toBe(401);
  });
});

describe('offline bootstrap guard', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db?.cleanup();
  });
  it('requires exactly two explicit distinct invitations and refuses re-population', async () => {
    await expect(
      bootstrapAdministrators(db.database, [{ email: 'one@example.test', roles: ['owner'] }]),
    ).rejects.toThrow();
    await expect(
      bootstrapAdministrators(db.database, [
        { email: 'same@example.test', roles: ['owner'] },
        { email: 'SAME@example.test', roles: ['support'] },
      ]),
    ).rejects.toThrow();
    const invitations = await bootstrapAdministrators(db.database, [
      { email: 'owner@example.test', roles: ['owner'] },
      { email: 'sys@example.test', roles: ['system_admin'], extraPermissions: ['sensitive.read'] },
    ]);
    expect(invitations).toHaveLength(2);
    expect(invitations[0]!.token).toHaveLength(43);
    expect(await db.database.client.adminAccount.count()).toBe(0);
    expect(await db.database.client.adminInvitation.count()).toBe(2);
    await expect(
      bootstrapAdministrators(db.database, [
        { email: 'third@example.test', roles: ['owner'] },
        { email: 'fourth@example.test', roles: ['support'] },
      ]),
    ).rejects.toThrow();
  });
  it('revokes an existing account and sessions with an audit event, without editing roles', async () => {
    const admin = await fixtureAdmin(db, ['support']);
    await revokeAdministrator(db.database, admin.account.email, 'Emergency response case 123');
    const saved = await db.database.client.adminAccount.findUnique({
      where: { id: admin.account.id },
    });
    expect(saved?.status).toBe('disabled');
    expect(saved?.authVersion).toBe(2);
    expect(saved?.roles).toEqual(['support']);
    expect(
      await db.database.client.adminAuditEvent.count({
        where: { action: 'account.revoke', resourceId: admin.account.id },
      }),
    ).toBe(1);
  });
});
