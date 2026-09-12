import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/main.js';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';
import { responseCookie } from '../helpers/http.js';

const origin = 'http://127.0.0.1:3000';
const password = 'correct horse battery staple';

describe('redemption concurrency', () => {
  let database: TestDatabase;
  let app: Awaited<ReturnType<typeof createApp>>;
  let mailbox: string;
  const post = (path: string, body: object, cookie?: string, key?: string) => {
    const call = request(app.getHttpServer())
      .post(`/api${path}`)
      .set('Origin', origin)
      .set(cookie ? 'Cookie' : 'Origin', cookie ?? origin)
      .send(body);
    return key ? call.set('Idempotency-Key', key) : call;
  };
  async function register(email: string, username: string): Promise<string> {
    await post('/auth/send-code', { email, purpose: 'register' }).expect(201);
    const messages = await Promise.all(
      (await readdir(mailbox)).map(async (name) =>
        JSON.parse(await readFile(join(mailbox, name), 'utf8')),
      ),
    );
    const registered = await post('/auth/register', {
      email,
      username,
      password,
      code: messages.find((message) => message.email === email).code,
    }).expect(201);
    return responseCookie(registered);
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    mailbox = await mkdtemp(join(tmpdir(), 'viviai-redemption-race-test-'));
    app = await createApp({ databaseUrl: database.url, devMailboxRoot: mailbox });
  });
  afterAll(async () => {
    await app?.close();
    await database?.cleanup();
    if (mailbox) await rm(mailbox, { recursive: true, force: true });
  });

  it('allows only one concurrent claimant when the campaign global limit is one', async () => {
    const firstCookie = await register('race-a@example.test', 'race_a');
    const secondCookie = await register('race-b@example.test', 'race_b');
    const rawCode = 'RACE-2026';
    const campaign = await database.database.client.redemptionCampaign.create({
      data: {
        name: 'Race',
        startsAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 60_000),
        credits: 30,
        totalLimit: 1,
      },
    });
    const code = await database.database.client.redemptionCode.create({
      data: {
        campaignId: campaign.id,
        digest: createHash('sha256').update(rawCode).digest('hex'),
        displayMask: 'RACE-****',
        maxUses: 20,
      },
    });

    const responses = await Promise.all([
      post('/account/redeem', { code: rawCode }, firstCookie, 'race-key-00000001'),
      post('/account/redeem', { code: rawCode }, secondCookie, 'race-key-00000002'),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 422]);
    expect(
      await database.database.client.redemptionClaim.count({ where: { codeId: code.id } }),
    ).toBe(1);
    expect(
      await database.database.client.redemptionCode.findUniqueOrThrow({ where: { id: code.id } }),
    ).toMatchObject({ usedCount: 1 });
  });
});
