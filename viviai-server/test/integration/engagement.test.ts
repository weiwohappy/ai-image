import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/main.js';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';
import { responseCookie } from '../helpers/http.js';
import { WalletService } from '../../src/modules/wallet/wallet.service.js';
import { ReferralService } from '../../src/modules/engagement/referral.service.js';

const origin = 'http://127.0.0.1:3000';
const password = 'correct horse battery staple';

describe('account engagement', () => {
  let database: TestDatabase;
  let app: Awaited<ReturnType<typeof createApp>>;
  let mailbox: string;
  let aliceCookie: string;
  let aliceId: string;
  let aliceInviteCode: string;

  const post = (path: string, body: object, cookie?: string) =>
    request(app.getHttpServer())
      .post(`/api${path}`)
      .set('Origin', origin)
      .set(cookie ? 'Cookie' : 'Origin', cookie ?? origin)
      .send(body);
  const get = (path: string, cookie: string) =>
    request(app.getHttpServer()).get(`/api${path}`).set('Cookie', cookie);
  async function code(email: string): Promise<string> {
    await post('/auth/send-code', { email, purpose: 'register' }).expect(201);
    const messages = await Promise.all(
      (await readdir(mailbox)).map(async (name) =>
        JSON.parse(await readFile(join(mailbox, name), 'utf8')),
      ),
    );
    return messages.find((message) => message.email === email && message.purpose === 'register')
      .code as string;
  }
  async function register(email: string, username: string, inviteCode?: string) {
    return post('/auth/register', {
      email,
      username,
      password,
      code: await code(email),
      ...(inviteCode ? { inviteCode } : {}),
    });
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    mailbox = await mkdtemp(join(tmpdir(), 'viviai-engagement-test-'));
    app = await createApp({ databaseUrl: database.url, devMailboxRoot: mailbox });
    const alice = await register('alice@example.test', 'alice');
    expect(alice.status).toBe(201);
    aliceCookie = responseCookie(alice);
    aliceId = alice.body.data.id;
    aliceInviteCode = alice.body.data.inviteCode;
  });

  afterAll(async () => {
    await app?.close();
    await database?.cleanup();
    if (mailbox) await rm(mailbox, { recursive: true, force: true });
  });

  it('lists only the caller notifications and exposes only safe internal action paths', async () => {
    await database.database.client.notification.createMany({
      data: [
        {
          userId: aliceId,
          type: 'system',
          title: 'Safe',
          body: 'visible',
          action: { href: '/account' },
        },
        {
          userId: aliceId,
          type: 'system',
          title: 'Unsafe',
          body: 'hidden link',
          action: { href: 'https://evil.example' },
        },
        {
          userId: aliceId,
          type: 'system',
          title: 'Protocol relative',
          body: 'hidden link',
          action: { href: '//evil.example' },
        },
        {
          userId: aliceId,
          type: 'system',
          title: 'Backslash',
          body: 'hidden link',
          action: { href: '/\\evil' },
        },
        {
          userId: aliceId,
          type: 'system',
          title: 'Control',
          body: 'hidden link',
          action: { href: '/safe\nunsafe' },
        },
      ],
    });
    const bob = await register('bob@example.test', 'bob');
    const bobCookie = responseCookie(bob);

    expect((await get('/notifications', bobCookie)).body.data).toEqual([]);
    const listed = await get('/notifications', aliceCookie).expect(200);
    expect(listed.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'Safe',
          content: 'visible',
          read: false,
          href: '/account',
        }),
        expect.objectContaining({ title: 'Unsafe', content: 'hidden link', read: false }),
      ]),
    );
    for (const title of ['Unsafe', 'Protocol relative', 'Backslash', 'Control'])
      expect(
        listed.body.data.find((notice: { title: string }) => notice.title === title),
      ).not.toHaveProperty('href');
  });

  it('marks only owned notifications read and keeps repeated reads idempotent', async () => {
    const own = await database.database.client.notification.create({
      data: { userId: aliceId, type: 'system', title: 'Read me', body: 'body' },
    });
    const bob = await database.database.client.user.findUniqueOrThrow({
      where: { email: 'bob@example.test' },
    });
    const foreign = await database.database.client.notification.create({
      data: { userId: bob.id, type: 'system', title: 'Private', body: 'body' },
    });

    await post(`/notifications/${foreign.id}/read`, {}, aliceCookie).expect(404);
    const first = await post(`/notifications/${own.id}/read`, {}, aliceCookie).expect(201);
    expect(first.body.data).toMatchObject({ id: own.id, read: true });
    const second = await post(`/notifications/${own.id}/read`, {}, aliceCookie).expect(201);
    expect(second.body.data).toMatchObject({ id: own.id, read: true });
    expect(
      await database.database.client.notification.findUniqueOrThrow({ where: { id: foreign.id } }),
    ).toMatchObject({ readAt: null });
  });

  it('marks the caller unread notifications read without touching another account', async () => {
    const own = await database.database.client.notification.create({
      data: { userId: aliceId, type: 'system', title: 'All', body: 'body' },
    });
    const bob = await database.database.client.user.findUniqueOrThrow({
      where: { email: 'bob@example.test' },
    });
    const foreign = await database.database.client.notification.create({
      data: { userId: bob.id, type: 'system', title: 'Foreign', body: 'body' },
    });

    expect(
      (await post('/notifications/read-all', {}, aliceCookie).expect(201)).body.data.updated,
    ).toBeGreaterThanOrEqual(1);
    expect(
      await database.database.client.notification.findUniqueOrThrow({ where: { id: own.id } }),
    ).not.toMatchObject({ readAt: null });
    expect(
      await database.database.client.notification.findUniqueOrThrow({ where: { id: foreign.id } }),
    ).toMatchObject({ readAt: null });
  });

  it('binds a valid invite atomically, rewards both accounts, and lists only supported referral status', async () => {
    const charlie = await register('charlie@example.test', 'charlie', aliceInviteCode);
    expect(charlie.status).toBe(201);
    const charlieId = charlie.body.data.id as string;

    const referral = await database.database.client.referral.findUniqueOrThrow({
      where: { inviteeUserId: charlieId },
    });
    expect(referral).toMatchObject({
      inviterUserId: aliceId,
      status: 'rewarded',
      rewardedAt: expect.any(Date),
    });
    expect(
      await database.database.client.user.findUniqueOrThrow({ where: { id: charlieId } }),
    ).toMatchObject({ invitedByUserId: aliceId });
    const wallet = new WalletService(database.database);
    expect((await wallet.balance(aliceId)).available).toBe(100n);
    expect((await wallet.balance(charlieId)).available).toBe(100n);
    expect(
      await database.database.client.creditLot.findUnique({
        where: { userId_sourceId: { userId: aliceId, sourceId: `invite:inviter:${referral.id}` } },
      }),
    ).not.toBeNull();
    expect(
      await database.database.client.creditLot.findUnique({
        where: {
          userId_sourceId: { userId: charlieId, sourceId: `invite:invitee:${referral.id}` },
        },
      }),
    ).not.toBeNull();
    expect((await get('/invites', aliceCookie).expect(200)).body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: referral.id,
          username: 'charlie',
          reward: 100,
          status: 'rewarded',
        }),
      ]),
    );
  });

  it('rejects invalid invite codes without persisting the registration and assigns compact stable codes', async () => {
    const unknown = await register('invalid@example.test', 'invalid', 'UNKNOWN1');
    expect(unknown.status).toBe(422);
    expect(unknown.body.code).toBe('INVALID_INVITE_CODE');
    expect(
      await database.database.client.user.count({ where: { email: 'invalid@example.test' } }),
    ).toBe(0);
    expect(aliceInviteCode).toMatch(/^[A-F0-9]{8}$/);
  });

  it('skips a locked invite-code collision and completes the atomic registration with the next candidate', async () => {
    const email = 'collision@example.test';
    const username = 'collision_user';
    const candidate = (attempt: number) =>
      createHash('sha256')
        .update(`${email}:${username}:${attempt}`)
        .digest('hex')
        .slice(0, 8)
        .toUpperCase();
    await database.database.client.user.create({
      data: {
        email: 'collision-owner@example.test',
        username: 'collision_owner',
        passwordHash: 'test-only-hash',
        inviteCode: candidate(0),
      },
    });

    const registered = await register(email, username);
    expect(registered.status).toBe(201);
    expect(registered.body.data.inviteCode).toBe(candidate(1));
    expect(await database.database.client.user.count({ where: { email } })).toBe(1);
  });

  it('rejects a self referral at the service boundary', async () => {
    const referrals = app.get(ReferralService);
    await expect(
      database.database.transaction((tx) =>
        referrals.bindAtRegistration(tx, aliceId, aliceInviteCode),
      ),
    ).rejects.toMatchObject({ status: 422, code: 'INVALID_INVITE_CODE' });
  });

  it('redeems a campaign code once, returns an authoritative balance, and creates a notification', async () => {
    const rawCode = 'WELCOME-2026';
    const campaign = await database.database.client.redemptionCampaign.create({
      data: {
        name: 'Welcome',
        startsAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 60_000),
        credits: 25,
        perUserLimit: 1,
      },
    });
    await database.database.client.redemptionCode.create({
      data: {
        campaignId: campaign.id,
        digest: createHash('sha256').update(rawCode).digest('hex'),
        displayMask: 'WELCOME-****',
        maxUses: 2,
      },
    });
    const key = 'redeem-key-00000001';
    const first = await post('/account/redeem', { code: rawCode }, aliceCookie)
      .set('Idempotency-Key', key)
      .expect(201);
    expect(first.body.data.credits).toBe(125);
    await request(app.getHttpServer())
      .patch('/api/account/profile')
      .set('Origin', origin)
      .set('Cookie', aliceCookie)
      .send({ username: 'alice_replayed' })
      .expect(200);
    await database.database.transaction((tx) =>
      new WalletService(database.database).grant(tx, aliceId, 'replay-mutation', 7n, null),
    );
    const replay = await post('/account/redeem', { code: rawCode }, aliceCookie)
      .set('Idempotency-Key', key)
      .expect(201);
    expect(replay.body.data).toEqual(first.body.data);
    expect(
      await database.database.client.redemptionClaim.count({ where: { idempotencyKey: key } }),
    ).toBe(1);
    expect(
      await database.database.client.notification.count({
        where: { userId: aliceId, type: 'credits', title: '兑换积分到账' },
      }),
    ).toBe(1);
    const conflict = await post('/account/redeem', { code: 'OTHER-CODE' }, aliceCookie)
      .set('Idempotency-Key', key)
      .expect(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('baselines a legacy null replay snapshot once without issuing another reward', async () => {
    const legacy = await register('legacy@example.test', 'legacy_user');
    const legacyId = legacy.body.data.id as string;
    const legacyCookie = responseCookie(legacy);
    const rawCode = 'LEGACY-2026';
    const campaign = await database.database.client.redemptionCampaign.create({
      data: {
        name: 'Legacy',
        startsAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 60_000),
        credits: 20,
      },
    });
    const code = await database.database.client.redemptionCode.create({
      data: {
        campaignId: campaign.id,
        digest: createHash('sha256').update(rawCode).digest('hex'),
        displayMask: 'LEGACY-****',
        maxUses: 5,
        usedCount: 1,
      },
    });
    const key = 'legacy-key-00000001';
    await database.database.client.redemptionClaim.create({
      data: { userId: legacyId, codeId: code.id, credits: 20, idempotencyKey: key },
    });
    const lotsBefore = await database.database.client.creditLot.count({
      where: { userId: legacyId },
    });

    const first = await post('/account/redeem', { code: rawCode }, legacyCookie)
      .set('Idempotency-Key', key)
      .expect(201);
    expect(first.body.data).toMatchObject({ username: 'legacy_user', credits: 0 });
    expect(await database.database.client.creditLot.count({ where: { userId: legacyId } })).toBe(
      lotsBefore,
    );
    expect(
      (await database.database.client.redemptionCode.findUniqueOrThrow({ where: { id: code.id } }))
        .usedCount,
    ).toBe(1);
    expect(
      await database.database.client.redemptionClaim.findUniqueOrThrow({
        where: { idempotencyKey: key },
      }),
    ).not.toMatchObject({ responseSnapshot: null });
    await request(app.getHttpServer())
      .patch('/api/account/profile')
      .set('Origin', origin)
      .set('Cookie', legacyCookie)
      .send({ username: 'legacy_changed' })
      .expect(200);
    await database.database.transaction((tx) =>
      new WalletService(database.database).grant(tx, legacyId, 'legacy-mutation', 9n, null),
    );
    const replay = await post('/account/redeem', { code: rawCode }, legacyCookie)
      .set('Idempotency-Key', key)
      .expect(201);
    expect(replay.body.data).toEqual(first.body.data);
    const different = await post('/account/redeem', { code: 'OTHER-CODE' }, legacyCookie)
      .set('Idempotency-Key', key)
      .expect(409);
    expect(different.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });
});
