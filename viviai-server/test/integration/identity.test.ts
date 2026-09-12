import { readdir, readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/main.js';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { responseCookie } from '../helpers/http.js';
import { isAccountExistsError } from '../../src/modules/identity/identity.service.js';

const origin = 'http://127.0.0.1:3000';
describe('private accounts', () => {
  let db: TestDatabase;
  let app: Awaited<ReturnType<typeof createApp>>;
  let mailbox: string;
  let cookie: string;
  const password = 'correct horse battery staple';
  const post = (path: string, body: object) =>
    request(app.getHttpServer()).post(`/api${path}`).set('Origin', origin).send(body);
  async function code(email: string, purpose = 'register') {
    const existing = new Set(await readdir(mailbox));
    await post('/auth/send-code', { email, purpose }).expect(201);
    const mails = await Promise.all(
      (await readdir(mailbox))
        .filter((name) => !existing.has(name))
        .map(async (name) => JSON.parse(await readFile(join(mailbox, name), 'utf8'))),
    );
    return mails.find((mail) => mail.email === email && mail.purpose === purpose)?.code as string;
  }
  beforeAll(async () => {
    db = await createTestDatabase();
    mailbox = await mkdtemp(join(tmpdir(), 'viviai-mail-test-'));
    app = await createApp({ databaseUrl: db.url, devMailboxRoot: mailbox });
  });
  afterAll(async () => {
    await app?.close();
    await db?.cleanup();
    if (mailbox) await rm(mailbox, { recursive: true, force: true });
  });

  it('rejects missing or foreign Origin on unsafe requests', async () => {
    for (const incoming of [undefined, 'https://evil.example']) {
      const call = request(app.getHttpServer()).post('/api/auth/login');
      if (incoming) call.set('Origin', incoming);
      expect((await call.send({ account: 'alice@example.test', password })).body.code).toBe(
        'CSRF_ORIGIN',
      );
    }
  });
  it('registers with a delivered code, exposes public account and uses a private cookie', async () => {
    const response = await post('/auth/register', {
      username: 'alice',
      email: 'alice@example.test',
      password,
      code: await code('alice@example.test'),
    }).expect(201);
    cookie = responseCookie(response);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\//);
    expect(response.body.data).toMatchObject({
      email: 'alice@example.test',
      username: 'alice',
      credits: 0,
      frozenCredits: 0,
    });
    expect(JSON.stringify(response.body)).not.toMatch(/passwordHash|tokenHash/);
    await request(app.getHttpServer()).get('/api/me').set('Cookie', cookie).expect(200);
  });
  it('classifies only account email and username P2002 metadata shapes', () => {
    expect(isAccountExistsError({ code: 'P2002', meta: { target: ['email'] } })).toBe(true);
    expect(isAccountExistsError({ code: 'P2002', meta: { target: 'users_username_key' } })).toBe(
      true,
    );
    expect(
      isAccountExistsError({
        code: 'P2002',
        meta: { driverAdapterError: { cause: { constraint: { index: 'users_email_key' } } } },
      }),
    ).toBe(true);
    expect(
      isAccountExistsError({
        code: 'P2002',
        meta: { driverAdapterError: { cause: { index: 'users_invite_code_key' } } },
      }),
    ).toBe(false);
  });
  it('returns ACCOUNT_EXISTS for duplicate email and username without referral or reward side effects', async () => {
    await db.database.client.emailChallenge.update({
      where: { email_purpose: { email: 'alice@example.test', purpose: 'register' } },
      data: { sentAt: new Date(Date.now() - 60_000) },
    });
    const emailDuplicate = await post('/auth/register', {
      username: 'email_duplicate',
      email: 'alice@example.test',
      password,
      code: await code('alice@example.test'),
    }).expect(409);
    expect(emailDuplicate.body.code).toBe('ACCOUNT_EXISTS');
    const usernameDuplicate = await post('/auth/register', {
      username: 'alice',
      email: 'username-duplicate@example.test',
      password,
      code: await code('username-duplicate@example.test'),
    }).expect(409);
    expect(usernameDuplicate.body.code).toBe('ACCOUNT_EXISTS');
    expect(await db.database.client.referral.count()).toBe(0);
    expect(await db.database.client.creditLot.count()).toBe(0);
  });
  it('rejects wrong password and accepts correct login by username', async () => {
    await post('/auth/login', { account: 'alice', password: 'wrong password' }).expect(401);
    const response = await post('/auth/login', { account: 'alice', password }).expect(201);
    expect(response.body.data.email).toBe('alice@example.test');
  });
  it('consumes reset codes once and revokes existing sessions', async () => {
    const resetCode = await code('alice@example.test', 'reset-password');
    await post('/auth/reset-password', {
      email: 'alice@example.test',
      code: resetCode,
      password: 'new correct horse battery',
    }).expect(201);
    await post('/auth/reset-password', {
      email: 'alice@example.test',
      code: resetCode,
      password,
    }).expect(400);
    await request(app.getHttpServer()).get('/api/me').set('Cookie', cookie).expect(401);
    await post('/auth/login', { account: 'alice', password }).expect(401);
    await post('/auth/login', { account: 'alice', password: 'new correct horse battery' }).expect(
      201,
    );
  });
  it('enforces resend cooldown and expired challenges', async () => {
    const challenge = await code('expired@example.test');
    await post('/auth/send-code', { email: 'expired@example.test', purpose: 'register' }).expect(
      429,
    );
    await db.database.client.emailChallenge.updateMany({
      where: { email: 'expired@example.test' },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await post('/auth/register', {
      email: 'expired@example.test',
      username: 'expired',
      password,
      code: challenge,
    }).expect(400);
  });
  it('commits incorrect attempts and blocks a correct code after five concurrent failures', async () => {
    const challenge = await code('locked@example.test');
    const wrong = challenge === '000000' ? '111111' : '000000';
    const body = { email: 'locked@example.test', username: 'locked', password, code: wrong };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => post('/auth/register', body)),
    );
    expect(results.map((result) => result.status)).toEqual([400, 400, 400, 400, 400]);
    await post('/auth/register', { ...body, code: challenge }).expect(400);
  });
  it('logout invalidates the persistent session', async () => {
    const loggedIn = await post('/auth/login', {
      account: 'alice',
      password: 'new correct horse battery',
    }).expect(201);
    const loggedCookie = responseCookie(loggedIn);
    await request(app.getHttpServer())
      .post('/api/auth/logout')
      .set('Origin', origin)
      .set('Cookie', loggedCookie)
      .expect(201);
    await request(app.getHttpServer()).get('/api/me').set('Cookie', loggedCookie).expect(401);
  });
  it('stores password and session hashes, rejects expired sessions', async () => {
    const response = await post('/auth/login', {
      account: 'alice',
      password: 'new correct horse battery',
    }).expect(201);
    const user = await db.database.client.user.findUniqueOrThrow({
      where: { email: 'alice@example.test' },
    });
    expect(user.passwordHash).not.toContain('new correct horse battery');
    const sessions = await db.database.client.session.findMany({ where: { userId: user.id } });
    for (const session of sessions)
      expect(responseCookie(response)).not.toContain(session.tokenHash);
    await db.database.client.session.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await request(app.getHttpServer())
      .get('/api/me')
      .set('Cookie', responseCookie(response))
      .expect(401);
  });
  it('issues Secure cookies when configured for production without sending external mail', async () => {
    const production = await createApp({
      databaseUrl: db.url,
      nodeEnv: 'production',
      devMailEnabled: false,
      simulationProviderEnabled: false,
      storageDriver: 's3',
      s3Bucket: 'private-test',
      s3Region: 'us-east-1',
      smtpUrl: 'smtp://127.0.0.1:1',
      mailFrom: 'noreply@example.test',
    });
    try {
      const response = await request(production.getHttpServer())
        .post('/api/auth/login')
        .set('Origin', origin)
        .send({ account: 'alice', password: 'new correct horse battery' })
        .expect(201);
      expect(responseCookie(response)).toMatch(/; Secure/);
    } finally {
      await production.close();
    }
  });
  it('allows only one concurrent redemption of a verification challenge', async () => {
    const challenge = await code('single@example.test');
    const body = { email: 'single@example.test', username: 'single', password, code: challenge };
    const responses = await Promise.all([
      post('/auth/register', body),
      post('/auth/register', body),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 400]);
  });
  it('keeps credential rate limits across application instances', async () => {
    for (let index = 0; index < 20; index++) {
      const response = await post('/auth/login', { account: 'rate-target', password: 'wrong' });
      expect({ attempt: index + 1, status: response.status, code: response.body.code }).toEqual({
        attempt: index + 1,
        status: 401,
        code: 'INVALID_CREDENTIALS',
      });
    }
    const second = await createApp({ databaseUrl: db.url, devMailboxRoot: mailbox });
    try {
      await request(second.getHttpServer())
        .post('/api/auth/login')
        .set('Origin', origin)
        .send({ account: 'rate-target', password: 'wrong' })
        .expect(429);
    } finally {
      await second.close();
    }
  });
  it('seeds only with explicit credentials and never overwrites an existing account', async () => {
    const execute = promisify(execFile);
    const env = {
      ...process.env,
      DATABASE_URL: db.url,
      NODE_ENV: 'development',
      DEV_SEED_EMAIL: 'seed@example.test',
      DEV_SEED_USERNAME: 'seed',
    };
    const noPassword = await execute(
      process.execPath,
      ['--import', 'tsx', 'src/scripts/seed-dev.ts'],
      { env: { ...env, DEV_SEED_PASSWORD: '' } },
    ).then(
      () => null,
      (error) => error,
    );
    expect(noPassword).toBeTruthy();
    const seeded = await execute(process.execPath, ['--import', 'tsx', 'src/scripts/seed-dev.ts'], {
      env: { ...env, DEV_SEED_PASSWORD: password, DEV_SEED_CREDITS: '1000' },
    }).then(
      () => 0,
      (error) => error.code,
    );
    expect(seeded).toBe(0);
    const login = await post('/auth/login', { account: 'seed', password }).expect(201);
    expect(login.body.data.credits).toBe(1000);
    const replacement = await execute(
      process.execPath,
      ['--import', 'tsx', 'src/scripts/seed-dev.ts'],
      { env: { ...env, DEV_SEED_PASSWORD: 'different seed password' } },
    ).then(
      () => null,
      (error) => error,
    );
    expect(replacement).toBeTruthy();
    await post('/auth/login', { account: 'seed', password }).expect(201);
    const prod = await execute(process.execPath, ['--import', 'tsx', 'src/scripts/seed-dev.ts'], {
      env: { ...env, NODE_ENV: 'production', DEV_SEED_PASSWORD: password },
    }).then(
      () => null,
      (error) => error,
    );
    expect(prod).toBeTruthy();
  });
});
