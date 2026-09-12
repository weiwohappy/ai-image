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

  it('rejects a second key for the same code even when the campaign allows multiple claims per user', async () => {
    const cookie = await register('duplicate@example.test', 'duplicate_user');
    const rawCode = 'DUPLICATE-2026';
    const campaign = await database.database.client.redemptionCampaign.create({
      data: {
        name: 'Duplicate',
        startsAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 60_000),
        credits: 10,
        perUserLimit: 2,
      },
    });
    await database.database.client.redemptionCode.create({
      data: {
        campaignId: campaign.id,
        digest: createHash('sha256').update(rawCode).digest('hex'),
        displayMask: 'DUPLICATE-****',
        maxUses: 5,
      },
    });

    await post('/account/redeem', { code: rawCode }, cookie, 'duplicate-key-00001').expect(201);
    const duplicate = await post(
      '/account/redeem',
      { code: rawCode },
      cookie,
      'duplicate-key-00002',
    ).expect(422);
    expect(duplicate.body.code).toBe('REDEMPTION_LIMIT_REACHED');
  });

  it('serializes a global idempotency key across different users and code inputs', async () => {
    const firstCookie = await register('same-key-a@example.test', 'same_key_a');
    const secondCookie = await register('same-key-b@example.test', 'same_key_b');
    const campaign = await database.database.client.redemptionCampaign.create({
      data: {
        name: 'Same key',
        startsAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 60_000),
        credits: 10,
      },
    });
    for (const rawCode of ['KEY-A-2026', 'KEY-B-2026'])
      await database.database.client.redemptionCode.create({
        data: {
          campaignId: campaign.id,
          digest: createHash('sha256').update(rawCode).digest('hex'),
          displayMask: 'KEY-****',
          maxUses: 5,
        },
      });

    const responses = await Promise.all([
      post('/account/redeem', { code: 'KEY-A-2026' }, firstCookie, 'global-key-0000001'),
      post('/account/redeem', { code: 'KEY-B-2026' }, secondCookie, 'global-key-0000001'),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(responses.find((response) => response.status === 409)?.body.code).toBe(
      'IDEMPOTENCY_CONFLICT',
    );
  });

  it('rejects inactive, unavailable, and exhausted redemption codes with business errors', async () => {
    const cookie = await register('validation@example.test', 'validation_user');
    const now = Date.now();
    const cases = [
      {
        rawCode: 'INACTIVE-2026',
        status: 'inactive',
        startsAt: now - 60_000,
        endsAt: now + 60_000,
        maxUses: 1,
        code: 'REDEMPTION_INVALID_OR_EXPIRED',
      },
      {
        rawCode: 'FUTURE-2026',
        status: 'active',
        startsAt: now + 60_000,
        endsAt: now + 120_000,
        maxUses: 1,
        code: 'REDEMPTION_INVALID_OR_EXPIRED',
      },
      {
        rawCode: 'EXHAUSTED-2026',
        status: 'active',
        startsAt: now - 60_000,
        endsAt: now + 60_000,
        maxUses: 0,
        code: 'REDEMPTION_LIMIT_REACHED',
      },
    ] as const;
    for (const [index, item] of cases.entries()) {
      const campaign = await database.database.client.redemptionCampaign.create({
        data: {
          name: item.rawCode,
          startsAt: new Date(item.startsAt),
          endsAt: new Date(item.endsAt),
          credits: 10,
          status: item.status,
        },
      });
      await database.database.client.redemptionCode.create({
        data: {
          campaignId: campaign.id,
          digest: createHash('sha256').update(item.rawCode).digest('hex'),
          displayMask: 'MASK-****',
          maxUses: item.maxUses,
        },
      });
      const response = await post(
        '/account/redeem',
        { code: item.rawCode },
        cookie,
        `validation-key-0000${index}`,
      );
      expect(response.status).toBe(422);
      expect(response.body.code).toBe(item.code);
    }
  });

  it('serializes campaign total limits across different redemption codes', async () => {
    const firstCookie = await register('total-a@example.test', 'total_a');
    const secondCookie = await register('total-b@example.test', 'total_b');
    const campaign = await database.database.client.redemptionCampaign.create({
      data: {
        name: 'Cross code total',
        startsAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 60_000),
        credits: 10,
        totalLimit: 1,
      },
    });
    for (const rawCode of ['TOTAL-A-2026', 'TOTAL-B-2026'])
      await database.database.client.redemptionCode.create({
        data: {
          campaignId: campaign.id,
          digest: createHash('sha256').update(rawCode).digest('hex'),
          displayMask: 'TOTAL-****',
          maxUses: 5,
        },
      });
    const responses = await Promise.all([
      post('/account/redeem', { code: 'TOTAL-A-2026' }, firstCookie, 'total-key-00000001'),
      post('/account/redeem', { code: 'TOTAL-B-2026' }, secondCookie, 'total-key-00000002'),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 422]);
  });
});
