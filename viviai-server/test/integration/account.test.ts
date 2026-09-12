import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../../src/main.js';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';
import { responseCookie } from '../helpers/http.js';
import { IdentityService } from '../../src/modules/identity/identity.service.js';

const origin = 'http://127.0.0.1:3000';
const password = 'correct horse battery staple';

describe('authenticated account commands', () => {
  let database: TestDatabase;
  let app: Awaited<ReturnType<typeof createApp>>;
  let mailbox: string;
  let cookie: string;

  const post = (path: string, body: object, session?: string) =>
    request(app.getHttpServer())
      .post(`/api${path}`)
      .set('Origin', origin)
      .set(session ? 'Cookie' : 'Origin', session ?? origin)
      .send(body);
  const patch = (path: string, session: string, body: object) =>
    request(app.getHttpServer())
      .patch(`/api${path}`)
      .set('Origin', origin)
      .set('Cookie', session)
      .send(body);
  async function code(email: string, purpose: string): Promise<string> {
    await post('/auth/send-code', { email, purpose }).expect(201);
    const messages = await Promise.all(
      (await readdir(mailbox)).map(async (name) =>
        JSON.parse(await readFile(join(mailbox, name), 'utf8')),
      ),
    );
    const message = messages.find((mail) => mail.email === email && mail.purpose === purpose);
    if (!message) throw new Error(`Missing ${purpose} challenge for ${email}`);
    return message.code as string;
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    mailbox = await mkdtemp(join(tmpdir(), 'viviai-account-test-'));
    app = await createApp({ databaseUrl: database.url, devMailboxRoot: mailbox });
    const registrationCode = await code('account@example.test', 'register');
    const registered = await post('/auth/register', {
      email: 'account@example.test',
      username: 'account_user',
      password,
      code: registrationCode,
    }).expect(201);
    cookie = responseCookie(registered);
  });

  afterAll(async () => {
    await app?.close();
    await database?.cleanup();
    if (mailbox) await rm(mailbox, { recursive: true, force: true });
  });

  it('updates a unique username and returns only the account DTO', async () => {
    const changed = await patch('/account/profile', cookie, { username: 'new_name' }).expect(200);

    expect(changed.body.data).toMatchObject({
      username: 'new_name',
      inviteCode: expect.any(String),
    });
    expect(changed.body.data).not.toHaveProperty('passwordHash');
    const otherRegistrationCode = await code('other@example.test', 'register');
    await post('/auth/register', {
      email: 'other@example.test',
      username: 'other_name',
      password,
      code: otherRegistrationCode,
    }).expect(201);
    await patch('/account/profile', cookie, { username: 'other_name' }).expect(409);
  });

  it('isolates change-email challenges and keeps only the initiating session', async () => {
    const secondLogin = await post('/auth/login', { account: 'new_name', password }).expect(201);
    const secondCookie = responseCookie(secondLogin);
    const nextEmail = 'changed@example.test';
    const passwordCode = await code(nextEmail, 'change-password');

    await post('/account/change-email', { email: nextEmail, code: passwordCode }, cookie).expect(400);

    const emailCode = await code(nextEmail, 'change-email');
    const changed = await post('/account/change-email', { email: nextEmail, code: emailCode }, cookie).expect(
      201,
    );
    expect(changed.body.data).toMatchObject({ email: nextEmail, username: 'new_name' });
    expect(changed.body.data).not.toHaveProperty('passwordHash');
    await post('/account/change-email', { email: nextEmail, code: emailCode }, cookie).expect(400);
    await request(app.getHttpServer()).get('/api/me').set('Cookie', cookie).expect(200);
    await request(app.getHttpServer()).get('/api/me').set('Cookie', secondCookie).expect(401);
  });

  it('isolates change-password challenges, validates password length, and preserves the session', async () => {
    const passwordAccountCode = await code('password@example.test', 'register');
    const passwordAccount = await post('/auth/register', {
      email: 'password@example.test',
      username: 'password_user',
      password,
      code: passwordAccountCode,
    }).expect(201);
    const passwordCookie = responseCookie(passwordAccount);
    const thirdLogin = await post('/auth/login', { account: 'password_user', password }).expect(201);
    const thirdCookie = responseCookie(thirdLogin);
    const nextPassword = 'a new correct horse battery';
    const emailCode = await code('password@example.test', 'change-email');

    await post('/account/change-password', { password: nextPassword, code: emailCode }, passwordCookie).expect(400);

    const passwordCode = await code('password@example.test', 'change-password');
    const rejectedPassword = await post(
      '/account/change-password',
      { password: 'too short', code: passwordCode },
      passwordCookie,
    ).expect(400);
    expect(rejectedPassword.body.code).toBe('INVALID_INPUT');
    await post('/account/change-password', { password: nextPassword, code: passwordCode }, passwordCookie).expect(201);
    await post('/account/change-password', { password: 'yet another correct horse battery', code: passwordCode }, passwordCookie).expect(400);
    await request(app.getHttpServer()).get('/api/me').set('Cookie', passwordCookie).expect(200);
    await request(app.getHttpServer()).get('/api/me').set('Cookie', thirdCookie).expect(401);
    await post('/auth/login', { account: 'password_user', password }).expect(401);
    await post('/auth/login', {
      account: 'password_user',
      password: nextPassword,
    }).expect(201);
  });

  it('invalidates delayed concurrent login sessions after email and password changes', async () => {
    const raceCode = await code('race@example.test', 'register');
    const raceRegistration = await post('/auth/register', {
      email: 'race@example.test',
      username: 'race_user',
      password,
      code: raceCode,
    }).expect(201);
    const raceCookie = responseCookie(raceRegistration);
    const identity = app.get(IdentityService);

    const emailLogin = await identity.login('race_user', password);
    const changedEmail = 'race-changed@example.test';
    const emailCode = await code(changedEmail, 'change-email');
    await post('/account/change-email', { email: changedEmail, code: emailCode }, raceCookie).expect(201);
    await expect(identity.createSession(emailLogin.id, emailLogin.authVersion)).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    await request(app.getHttpServer()).get('/api/me').set('Cookie', raceCookie).expect(200);

    const passwordLogin = await identity.login('race_user', password);
    const newPassword = 'race new correct horse battery';
    const passwordCode = await code(changedEmail, 'change-password');
    await post('/account/change-password', { password: newPassword, code: passwordCode }, raceCookie).expect(
      201,
    );
    await expect(identity.createSession(passwordLogin.id, passwordLogin.authVersion)).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    await request(app.getHttpServer()).get('/api/me').set('Cookie', raceCookie).expect(200);
  });
});
