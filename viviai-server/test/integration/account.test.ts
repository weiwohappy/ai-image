import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../../src/main.js';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';
import { responseCookie } from '../helpers/http.js';

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
    const passwordCode = await code('account@example.test', 'change-password');

    await post('/account/change-email', { email: nextEmail, code: passwordCode }, cookie).expect(400);

    const emailCode = await code(nextEmail, 'change-email');
    const changed = await post('/account/change-email', { email: nextEmail, code: emailCode }, cookie).expect(
      201,
    );
    expect(changed.body.data).toMatchObject({ email: nextEmail, username: 'new_name' });
    expect(changed.body.data).not.toHaveProperty('passwordHash');
    await request(app.getHttpServer()).get('/api/me').set('Cookie', cookie).expect(200);
    await request(app.getHttpServer()).get('/api/me').set('Cookie', secondCookie).expect(401);
  });

  it('isolates change-password challenges, validates password length, and preserves the session', async () => {
    const thirdLogin = await post('/auth/login', {
      account: 'changed@example.test',
      password,
    }).expect(201);
    const thirdCookie = responseCookie(thirdLogin);
    const emailCode = await code('wrong-purpose@example.test', 'change-email');

    await post('/account/change-password', { password: 'too short', code: emailCode }, cookie).expect(400);

    const passwordCode = await code('changed@example.test', 'change-password');
    await post('/account/change-password', { password: 'a new correct horse battery', code: passwordCode }, cookie).expect(
      201,
    );
    await request(app.getHttpServer()).get('/api/me').set('Cookie', cookie).expect(200);
    await request(app.getHttpServer()).get('/api/me').set('Cookie', thirdCookie).expect(401);
    await post('/auth/login', { account: 'new_name', password }).expect(401);
    await post('/auth/login', {
      account: 'new_name',
      password: 'a new correct horse battery',
    }).expect(201);
  });
});
