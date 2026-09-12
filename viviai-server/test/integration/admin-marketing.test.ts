import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../../src/shared/database/database.service.js';
import { adminApp, adminOrigin, fixtureAdmin } from '../helpers/admin.js';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';

const reason = 'Marketing operation approved for integration test';

describe('admin redemption and referral operations', () => {
  let db: TestDatabase;
  let app: Awaited<ReturnType<typeof adminApp>>;
  let superAdmin: Awaited<ReturnType<typeof fixtureAdmin>>;
  let owner: Awaited<ReturnType<typeof fixtureAdmin>>;
  let contentOperator: Awaited<ReturnType<typeof fixtureAdmin>>;

  const call = (
    method: 'get' | 'post' | 'patch',
    cookie: string,
    path: string,
    input: Record<string, unknown> = {},
    key = randomUUID(),
  ) => {
    const pending = request(app.getHttpServer())
      [method](`/api/admin${path}`)
      .set('Cookie', cookie)
      .set('Origin', adminOrigin)
      .set('Idempotency-Key', key);
    return method === 'get' ? pending.query(input) : pending.send(input);
  };

  const campaignInput = (name = `Campaign ${randomUUID().slice(0, 8)}`) => ({
    name,
    startsAt: new Date(Date.now() - 60_000).toISOString(),
    endsAt: new Date(Date.now() + 86_400_000).toISOString(),
    perUserLimit: 2,
    credits: 120,
    totalLimit: 100,
    reason,
  });

  const createCampaign = async (cookie = superAdmin.cookie) => {
    const input = campaignInput();
    const response = await call('post', cookie, '/redemption-campaigns', input);
    expect(response.status).toBe(201);
    return { input, row: response.body.data };
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    app = await adminApp(db, { nodeEnv: 'development', host: '127.0.0.1' });
    superAdmin = await fixtureAdmin(db, ['super_admin']);
    owner = await fixtureAdmin(db, ['owner']);
    contentOperator = await fixtureAdmin(db, ['content_operator']);
  });

  afterAll(async () => {
    await app.close();
    await db.cleanup();
  });

  it('enforces Origin and exact marketing permissions before campaign writes', async () => {
    const input = campaignInput();
    const wrongOrigin = await request(app.getHttpServer())
      .post('/api/admin/redemption-campaigns')
      .set('Cookie', superAdmin.cookie)
      .set('Origin', 'https://evil.example.test')
      .set('Idempotency-Key', randomUUID())
      .send(input);
    expect(wrongOrigin.status).toBe(403);
    expect(
      (await call('post', contentOperator.cookie, '/redemption-campaigns', input)).status,
    ).toBe(403);
    expect(
      (
        await call('post', contentOperator.cookie, '/redemption-campaigns', {
          ...input,
          startsAt: new Date(Date.now() - 120_000).toISOString(),
          endsAt: new Date(Date.now() - 60_000).toISOString(),
        })
      ).status,
    ).toBe(403);
    expect((await createCampaign(owner.cookie)).row).toMatchObject({
      status: 'active',
      version: 1,
    });
  });

  it('creates, updates, disables and archives campaigns with versions and safe receipts', async () => {
    const key = randomUUID();
    const input = campaignInput('Lifecycle campaign');
    const created = await call('post', superAdmin.cookie, '/redemption-campaigns', input, key);
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      name: input.name,
      status: 'active',
      version: 1,
    });
    expect(
      (await call('post', superAdmin.cookie, '/redemption-campaigns', input, key)).body.data,
    ).toEqual(created.body.data);
    expect(
      (
        await call(
          'post',
          superAdmin.cookie,
          '/redemption-campaigns',
          { ...input, credits: 121 },
          key,
        )
      ).body.code,
    ).toBe('ADMIN_IDEMPOTENCY_CONFLICT');
    expect(
      (
        await request(app.getHttpServer())
          .post('/api/admin/team/roles')
          .set('Cookie', superAdmin.cookie)
          .set('Origin', adminOrigin)
          .set('Idempotency-Key', key)
          .send({
            key: `custom_marketing_receipt_${randomUUID().replaceAll('-', '').slice(0, 8)}`,
            name: 'Cross-domain receipt conflict',
            description: 'Must not reuse a marketing command receipt',
            permissions: ['dashboard.read'],
            reason,
          })
      ).body.code,
    ).toBe('ADMIN_IDEMPOTENCY_CONFLICT');

    const stale = await call(
      'patch',
      superAdmin.cookie,
      `/redemption-campaigns/${created.body.data.id}`,
      { ...input, name: 'Updated campaign', version: 9 },
    );
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('REDEMPTION_VERSION_CONFLICT');
    const updated = await call(
      'patch',
      superAdmin.cookie,
      `/redemption-campaigns/${created.body.data.id}`,
      { ...input, name: 'Updated campaign', version: 1 },
    );
    expect(updated.body.data).toMatchObject({ name: 'Updated campaign', version: 2 });
    const disabled = await call(
      'post',
      superAdmin.cookie,
      `/redemption-campaigns/${created.body.data.id}/disable`,
      { version: 2, reason },
    );
    expect(disabled.body.data).toMatchObject({ status: 'disabled', version: 3 });
    const archived = await call(
      'post',
      superAdmin.cookie,
      `/redemption-campaigns/${created.body.data.id}/archive`,
      { version: 3, reason },
    );
    expect(archived.body.data).toMatchObject({ status: 'archived', version: 4 });
    expect(
      (
        await call('patch', superAdmin.cookie, `/redemption-campaigns/${created.body.data.id}`, {
          ...input,
          name: 'Cannot revive',
          version: 4,
        })
      ).status,
    ).toBe(422);
    expect(
      await db.database.client.adminAuditEvent.count({
        where: {
          action: { startsWith: 'redemptions.campaign.' },
          resourceId: created.body.data.id,
          outcome: 'allowed',
        },
      }),
    ).toBe(4);
  });

  it('paginates filtered campaigns and returns a safe detail projection', async () => {
    const prefix = `List ${randomUUID().slice(0, 8)}`;
    const ids: string[] = [];
    for (let index = 0; index < 3; index++) {
      const response = await call(
        'post',
        superAdmin.cookie,
        '/redemption-campaigns',
        campaignInput(`${prefix} ${index}`),
      );
      ids.push(response.body.data.id);
    }
    const first = await call('get', superAdmin.cookie, '/redemption-campaigns', {
      q: prefix,
      status: 'active',
      limit: 2,
    });
    expect(first.body.data.rows).toHaveLength(2);
    expect(first.body.data.nextCursor).toEqual(expect.any(String));
    const second = await call('get', superAdmin.cookie, '/redemption-campaigns', {
      q: prefix,
      status: 'active',
      limit: 2,
      cursor: first.body.data.nextCursor,
    });
    expect(second.body.data.rows).toHaveLength(1);
    expect(
      new Set([...first.body.data.rows, ...second.body.data.rows].map((row) => row.id)),
    ).toEqual(new Set(ids));
    expect(
      (
        await call('get', superAdmin.cookie, '/redemption-campaigns', {
          q: `${prefix} foreign`,
          status: 'active',
          cursor: first.body.data.nextCursor,
        })
      ).status,
    ).toBe(400);
    const detail = await call('get', superAdmin.cookie, `/redemption-campaigns/${ids[0]}`);
    expect(detail.body.data).toMatchObject({ id: ids[0], codeCount: 0, status: 'active' });
    expect(detail.body.data).not.toHaveProperty('digest');
  });

  it('reauthorizes after the shared receipt lock and obeys the global write gate', async () => {
    const revoked = await fixtureAdmin(db, ['owner']);
    const key = randomUUID();
    const blocker = new pg.Client({ connectionString: db.url });
    await blocker.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `admin:command-receipt:${revoked.account.id}:${key}`,
    ]);
    const before = await db.database.client.redemptionCampaign.count();
    const pending = call(
      'post',
      revoked.cookie,
      '/redemption-campaigns',
      campaignInput('Reauthorization campaign'),
      key,
    ).then((response) => response);
    try {
      expect(await waitForExactAdvisoryWaiters(blocker, 1)).toBe(true);
      await db.database.client.adminAccountRole.delete({
        where: { accountId_roleKey: { accountId: revoked.account.id, roleKey: 'owner' } },
      });
      await blocker.query('COMMIT');
      const response = await pending;
      expect(response.status).toBe(401);
      expect(await db.database.client.redemptionCampaign.count()).toBe(before);
      expect(
        await db.database.client.adminCommandReceipt.count({ where: { idempotencyKey: key } }),
      ).toBe(0);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      await blocker.end();
      await Promise.allSettled([pending]);
    }

    const gatedApp = await adminApp(db, { nodeEnv: 'test', host: '127.0.0.1' });
    try {
      const gated = await request(gatedApp.getHttpServer())
        .post('/api/admin/redemption-campaigns')
        .set('Cookie', superAdmin.cookie)
        .set('Origin', adminOrigin)
        .set('Idempotency-Key', randomUUID())
        .send(campaignInput('Write-gated campaign'));
      expect(gated.status).toBe(503);
      expect(await db.database.client.redemptionCampaign.count()).toBe(before);
    } finally {
      await gatedApp.close();
    }
  });

  it('generates high-entropy unique codes once and replays only a safe receipt', async () => {
    const { row: campaign } = await createCampaign();
    const key = randomUUID();
    const first = await call(
      'post',
      superAdmin.cookie,
      '/redemption-codes',
      { campaignId: campaign.id, campaignVersion: 1, quantity: 3, maxUses: 2, reason },
      key,
    );
    expect(first.status).toBe(201);
    expect(first.body.data.codes).toHaveLength(3);
    const plaintext = first.body.data.codes.map((item: { code: string }) => item.code);
    expect(new Set(plaintext).size).toBe(3);
    for (const code of plaintext) expect(code).toMatch(/^VIVIAI-[A-F0-9]{32}$/);

    const stored = await db.database.client.redemptionCode.findMany({
      where: { campaignId: campaign.id },
      orderBy: { id: 'asc' },
    });
    expect(stored).toHaveLength(3);
    expect(new Set(stored.map((row) => row.digest)).size).toBe(3);
    expect(stored.map((row) => row.digest).sort()).toEqual(
      plaintext
        .map((code: string) => createHash('sha256').update(code.trim().toUpperCase()).digest('hex'))
        .sort(),
    );
    const replay = await call(
      'post',
      superAdmin.cookie,
      '/redemption-codes',
      { campaignId: campaign.id, campaignVersion: 1, quantity: 3, maxUses: 2, reason },
      key,
    );
    expect(replay.status).toBe(201);
    expect(replay.body.data).toMatchObject({
      campaignId: campaign.id,
      generated: 3,
      codesUnavailable: true,
    });
    expect(replay.body.data).not.toHaveProperty('codes');
    expect(
      (
        await call(
          'post',
          superAdmin.cookie,
          '/redemption-codes',
          { campaignId: campaign.id, campaignVersion: 1, quantity: 2, maxUses: 2, reason },
          key,
        )
      ).body.code,
    ).toBe('ADMIN_IDEMPOTENCY_CONFLICT');
    expect(
      await db.database.client.redemptionCode.count({ where: { campaignId: campaign.id } }),
    ).toBe(3);
    const persistent = JSON.stringify({
      codes: stored,
      receipts: await db.database.client.adminCommandReceipt.findMany({
        where: { idempotencyKey: key },
      }),
      audit: await db.database.client.adminAuditEvent.findMany({
        where: { action: 'redemptions.codes.generate' },
      }),
    });
    for (const code of plaintext) expect(persistent).not.toContain(code);
    expect(persistent).not.toContain(reason);
  });

  it('rejects unsafe batch sizes and expired or over-capacity campaigns without codes', async () => {
    const { row: campaign } = await createCampaign();
    for (const quantity of [0, 1001]) {
      expect(
        (
          await call('post', superAdmin.cookie, '/redemption-codes', {
            campaignId: campaign.id,
            campaignVersion: 1,
            quantity,
            maxUses: 1,
            reason,
          })
        ).status,
      ).toBe(400);
    }
    const expired = await db.database.client.redemptionCampaign.create({
      data: {
        name: 'Expired campaign',
        startsAt: new Date(Date.now() - 120_000),
        endsAt: new Date(Date.now() - 60_000),
        perUserLimit: 1,
        credits: 10,
        totalLimit: 10,
      },
    });
    const expiredBatch = await call('post', superAdmin.cookie, '/redemption-codes', {
      campaignId: expired.id,
      campaignVersion: 1,
      quantity: 1,
      maxUses: 1,
      reason,
    });
    expect(expiredBatch.status).toBe(422);
    expect(expiredBatch.body.code).toBe('REDEMPTION_CAMPAIGN_UNAVAILABLE');
    const overCapacity = await call('post', superAdmin.cookie, '/redemption-codes', {
      campaignId: campaign.id,
      campaignVersion: 1,
      quantity: 51,
      maxUses: 2,
      reason,
    });
    expect(overCapacity.status).toBe(422);
    const staleCampaign = await call('post', superAdmin.cookie, '/redemption-codes', {
      campaignId: campaign.id,
      campaignVersion: 9,
      quantity: 1,
      maxUses: 1,
      reason,
    });
    expect(staleCampaign.status).toBe(409);
    expect(staleCampaign.body.code).toBe('REDEMPTION_VERSION_CONFLICT');
    expect(
      await db.database.client.redemptionCode.count({ where: { campaignId: campaign.id } }),
    ).toBe(0);
  });

  it('serializes campaign capacity, versions generated batches, and releases only disabled-code remaining uses', async () => {
    const capacityInput = { ...campaignInput('Capacity campaign'), totalLimit: 10 };
    const created = await call('post', superAdmin.cookie, '/redemption-campaigns', capacityInput);
    const campaignId = created.body.data.id as string;
    const users = await Promise.all(
      [0, 1].map((index) =>
        db.database.client.user.create({
          data: {
            email: `capacity-${randomUUID()}@example.test`,
            username: `capacity-user-${randomUUID()}`,
            passwordHash: `capacity-hash-${index}`,
          },
        }),
      ),
    );
    const active = await db.database.client.redemptionCode.create({
      data: {
        campaignId,
        digest: createHash('sha256').update(`capacity-active-${randomUUID()}`).digest('hex'),
        displayMask: 'CAPACITY-****-0001',
        maxUses: 4,
        usedCount: 1,
      },
    });
    const disabled = await db.database.client.redemptionCode.create({
      data: {
        campaignId,
        digest: createHash('sha256').update(`capacity-disabled-${randomUUID()}`).digest('hex'),
        displayMask: 'CAPACITY-****-0002',
        status: 'disabled',
        maxUses: 4,
        usedCount: 1,
      },
    });
    await db.database.client.redemptionClaim.createMany({
      data: [
        {
          userId: users[0]!.id,
          codeId: active.id,
          credits: capacityInput.credits,
          idempotencyKey: randomUUID(),
        },
        {
          userId: users[1]!.id,
          codeId: disabled.id,
          credits: capacityInput.credits,
          idempotencyKey: randomUUID(),
        },
      ],
    });

    const belowReserved = await call(
      'patch',
      superAdmin.cookie,
      `/redemption-campaigns/${campaignId}`,
      { ...capacityInput, totalLimit: 4, version: 1 },
    );
    expect(belowReserved.status).toBe(422);
    expect(belowReserved.body.code).toBe('REDEMPTION_CAMPAIGN_LIMIT_EXCEEDED');

    const disabledActive = await call(
      'post',
      superAdmin.cookie,
      `/redemption-codes/${active.id}/disable`,
      { version: 1, reason },
    );
    expect(disabledActive.status).toBe(201);
    const exactlyClaims = await call(
      'patch',
      superAdmin.cookie,
      `/redemption-campaigns/${campaignId}`,
      { ...capacityInput, totalLimit: 2, version: 1 },
    );
    expect(exactlyClaims.status).toBe(200);
    expect(exactlyClaims.body.data).toMatchObject({ totalLimit: 2, version: 2 });

    const concurrentInput = { ...campaignInput('Concurrent capacity campaign'), totalLimit: 2 };
    const concurrentCampaign = await call(
      'post',
      superAdmin.cookie,
      '/redemption-campaigns',
      concurrentInput,
    );
    const attempts = await Promise.all(
      [randomUUID(), randomUUID()].map((key) =>
        call(
          'post',
          superAdmin.cookie,
          '/redemption-codes',
          {
            campaignId: concurrentCampaign.body.data.id,
            campaignVersion: 1,
            quantity: 1,
            maxUses: 2,
            reason,
          },
          key,
        ),
      ),
    );
    expect(attempts.map((response) => response.status).sort()).toEqual([201, 409]);
    const winner = attempts.find((response) => response.status === 201)!;
    expect(winner.body.data).toMatchObject({ campaignVersion: 2, generated: 1 });
    expect(
      await db.database.client.redemptionCode.count({
        where: { campaignId: concurrentCampaign.body.data.id },
      }),
    ).toBe(1);
    expect(
      (
        await db.database.client.redemptionCampaign.findUniqueOrThrow({
          where: { id: concurrentCampaign.body.data.id },
        })
      ).version,
    ).toBe(2);
    const sequentialOverflow = await call('post', superAdmin.cookie, '/redemption-codes', {
      campaignId: concurrentCampaign.body.data.id,
      campaignVersion: 2,
      quantity: 1,
      maxUses: 1,
      reason,
    });
    expect(sequentialOverflow.status).toBe(422);
    expect(sequentialOverflow.body.code).toBe('REDEMPTION_CAMPAIGN_LIMIT_EXCEEDED');
  });

  it('compares campaign and list timestamps by epoch across offsets and rejects equal or reversed ranges', async () => {
    const validCampaign = await call('post', superAdmin.cookie, '/redemption-campaigns', {
      ...campaignInput('Offset-valid campaign'),
      startsAt: '2030-01-01T12:00:00+08:00',
      endsAt: '2030-01-01T05:00:00Z',
    });
    expect(validCampaign.status).toBe(201);
    for (const [startsAt, endsAt] of [
      ['2030-01-01T04:30:00Z', '2030-01-01T12:00:00+08:00'],
      ['2030-01-01T12:00:00+08:00', '2030-01-01T04:00:00Z'],
    ]) {
      expect(
        (
          await call('post', superAdmin.cookie, '/redemption-campaigns', {
            ...campaignInput('Offset-invalid campaign'),
            startsAt,
            endsAt,
          })
        ).status,
      ).toBe(400);
    }

    for (const path of [
      '/redemption-campaigns',
      '/redemption-codes',
      '/redemption-claims',
      '/referrals',
    ]) {
      expect(
        (
          await call('get', superAdmin.cookie, path, {
            from: '2026-06-01T10:00:00+08:00',
            to: '2026-06-01T03:00:00Z',
          })
        ).status,
      ).toBe(200);
      for (const [from, to] of [
        ['2026-06-01T02:30:00Z', '2026-06-01T10:00:00+08:00'],
        ['2026-06-01T10:00:00+08:00', '2026-06-01T02:00:00Z'],
        ['not-a-date', '2026-06-01T03:00:00Z'],
      ])
        expect((await call('get', superAdmin.cookie, path, { from, to })).status).toBe(400);
    }
  });

  it('lists only masked codes and disables one with optimistic versioning', async () => {
    const { row: campaign } = await createCampaign();
    const generated = await call('post', superAdmin.cookie, '/redemption-codes', {
      campaignId: campaign.id,
      campaignVersion: 1,
      quantity: 2,
      maxUses: 5,
      reason,
    });
    const secret = generated.body.data.codes[0].code as string;
    const id = generated.body.data.codes[0].id as string;
    const listed = await call('get', superAdmin.cookie, '/redemption-codes', {
      campaignId: campaign.id,
      limit: 1,
    });
    expect(listed.status).toBe(200);
    expect(listed.body.data.rows).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain(secret);
    expect(listed.body.data.rows[0]).not.toHaveProperty('digest');
    expect(listed.body.data.nextCursor).toEqual(expect.any(String));
    const detail = await call('get', superAdmin.cookie, `/redemption-codes/${id}`);
    expect(detail.body.data).not.toHaveProperty('digest');
    expect(detail.body.data).toMatchObject({ id, version: 1, status: 'active' });
    const disabled = await call('post', superAdmin.cookie, `/redemption-codes/${id}/disable`, {
      version: 1,
      reason,
    });
    expect(disabled.body.data).toMatchObject({ id, version: 2, status: 'disabled' });
    const stale = await call('post', superAdmin.cookie, `/redemption-codes/${id}/disable`, {
      version: 1,
      reason,
    });
    expect(stale.status).toBe(409);
  });

  it('paginates and filters claims without exposing account or code secrets', async () => {
    const campaign = await db.database.client.redemptionCampaign.create({
      data: {
        name: 'Claims campaign',
        startsAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 60_000),
        perUserLimit: 5,
        credits: 20,
        totalLimit: 20,
      },
    });
    const when = new Date('2026-06-01T12:00:00.000Z');
    const claimIds: string[] = [];
    const userIds: string[] = [];
    for (let index = 0; index < 3; index++) {
      const user = await db.database.client.user.create({
        data: {
          email: `claim${index}@example.test`,
          username: `private-claim-profile-${randomUUID()}`,
          passwordHash: `private-claim-hash-${index}`,
        },
      });
      const code = await db.database.client.redemptionCode.create({
        data: {
          campaignId: campaign.id,
          digest: createHash('sha256').update(`secret-claim-code-${index}`).digest('hex'),
          displayMask: `CLAIM-****-${index}`,
          maxUses: 1,
          usedCount: 1,
        },
      });
      const claim = await db.database.client.redemptionClaim.create({
        data: {
          userId: user.id,
          codeId: code.id,
          credits: 20,
          idempotencyKey: randomUUID(),
          createdAt: when,
        },
      });
      userIds.push(user.id);
      claimIds.push(claim.id);
    }
    const first = await call('get', superAdmin.cookie, '/redemption-claims', {
      campaignId: campaign.id,
      limit: 2,
    });
    expect(first.status).toBe(200);
    expect(first.body.data.rows).toHaveLength(2);
    expect(first.body.data.nextCursor).toEqual(expect.any(String));
    const second = await call('get', superAdmin.cookie, '/redemption-claims', {
      campaignId: campaign.id,
      limit: 2,
      cursor: first.body.data.nextCursor,
    });
    expect(second.body.data.rows).toHaveLength(1);
    expect(
      new Set([...first.body.data.rows, ...second.body.data.rows].map((row) => row.id)),
    ).toEqual(new Set(claimIds));
    const filtered = await call('get', superAdmin.cookie, '/redemption-claims', {
      userId: userIds[0],
    });
    expect(filtered.body.data.rows).toHaveLength(1);
    expect(filtered.body.data.rows[0]).toMatchObject({
      userId: userIds[0],
      userEmail: 'c***@example.test',
      campaignId: campaign.id,
      campaignName: 'Claims campaign',
      credits: 20,
    });
    const safe = JSON.stringify([...first.body.data.rows, ...second.body.data.rows]);
    expect(safe).not.toContain('passwordHash');
    expect(safe).not.toContain('authVersion');
    expect(safe).not.toContain('inviteCode');
    expect(safe).not.toContain('private-claim-profile');
    expect(safe).not.toContain('secret-claim-code');
    expect((await call('get', contentOperator.cookie, '/redemption-claims')).status).toBe(403);
  });

  it('paginates redacted referrals with stable participant IDs and exact filters', async () => {
    const when = new Date('2026-07-01T08:00:00.000Z');
    const referralIds: string[] = [];
    const inviterIds: string[] = [];
    for (let index = 0; index < 3; index++) {
      const inviter = await db.database.client.user.create({
        data: {
          email: `inviter${index}@example.test`,
          username: `private-inviter-${randomUUID()}`,
          passwordHash: `private-inviter-hash-${index}`,
        },
      });
      const invitee = await db.database.client.user.create({
        data: {
          email: `invitee${index}@example.test`,
          username: `private-invitee-${randomUUID()}`,
          passwordHash: `private-invitee-hash-${index}`,
        },
      });
      const referral = await db.database.client.referral.create({
        data: {
          inviterUserId: inviter.id,
          inviteeUserId: invitee.id,
          status: index === 2 ? 'pending' : 'rewarded',
          rewardCredits: 100 + index,
          qualifiedAt: index === 2 ? null : when,
          rewardedAt: index === 2 ? null : when,
          createdAt: when,
        },
      });
      inviterIds.push(inviter.id);
      referralIds.push(referral.id);
    }
    const first = await call('get', owner.cookie, '/referrals', { limit: 2 });
    const second = await call('get', owner.cookie, '/referrals', {
      limit: 2,
      cursor: first.body.data.nextCursor,
    });
    expect(
      new Set([...first.body.data.rows, ...second.body.data.rows].map((row) => row.id)),
    ).toEqual(new Set(referralIds));
    const filtered = await call('get', owner.cookie, '/referrals', {
      userId: inviterIds[0],
      status: 'rewarded',
    });
    expect(filtered.body.data.rows).toHaveLength(1);
    expect(filtered.body.data.rows[0]).toMatchObject({
      inviterUserId: inviterIds[0],
      inviterEmail: 'i***@example.test',
      inviteeEmail: 'i***@example.test',
      status: 'rewarded',
      rewardCredits: 100,
    });
    const safe = JSON.stringify([...first.body.data.rows, ...second.body.data.rows]);
    for (const forbidden of [
      'passwordHash',
      'authVersion',
      'inviteCode',
      'private-inviter',
      'private-invitee',
      'inviter0@example.test',
      'invitee0@example.test',
    ])
      expect(safe).not.toContain(forbidden);
    expect((await call('get', contentOperator.cookie, '/referrals')).status).toBe(403);
  });

  it('queries codes, claims, and referrals through explicit minimal top-level projections', async () => {
    const campaign = await db.database.client.redemptionCampaign.create({
      data: {
        name: 'Projection campaign',
        startsAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 60_000),
        perUserLimit: 1,
        credits: 1,
        totalLimit: 1,
      },
    });
    const code = await db.database.client.redemptionCode.create({
      data: {
        campaignId: campaign.id,
        digest: createHash('sha256').update(`projection-${randomUUID()}`).digest('hex'),
        displayMask: 'PROJECTION-****-0001',
        maxUses: 1,
      },
    });
    const user = await db.database.client.user.create({
      data: {
        email: `projection-${randomUUID()}@example.test`,
        username: `projection-private-${randomUUID()}`,
        passwordHash: 'projection-private-password-hash',
      },
    });
    await db.database.client.redemptionClaim.create({
      data: {
        userId: user.id,
        codeId: code.id,
        credits: 1,
        idempotencyKey: randomUUID(),
        responseSnapshot: { private: 'projection-private-snapshot' },
      },
    });
    const invitee = await db.database.client.user.create({
      data: {
        email: `projection-invitee-${randomUUID()}@example.test`,
        username: `projection-invitee-private-${randomUUID()}`,
        passwordHash: 'projection-invitee-private-password-hash',
      },
    });
    await db.database.client.referral.create({
      data: { inviterUserId: user.id, inviteeUserId: invitee.id },
    });

    const applicationDatabase = app.get(DatabaseService);
    const codeList = vi.spyOn(applicationDatabase.client.redemptionCode, 'findMany');
    const codeDetail = vi.spyOn(applicationDatabase.client.redemptionCode, 'findUnique');
    const claimList = vi.spyOn(applicationDatabase.client.redemptionClaim, 'findMany');
    const referralList = vi.spyOn(applicationDatabase.client.referral, 'findMany');
    try {
      expect(
        (await call('get', superAdmin.cookie, '/redemption-codes', { campaignId: campaign.id }))
          .status,
      ).toBe(200);
      expect((await call('get', superAdmin.cookie, `/redemption-codes/${code.id}`)).status).toBe(
        200,
      );
      expect(
        (await call('get', superAdmin.cookie, '/redemption-claims', { campaignId: campaign.id }))
          .status,
      ).toBe(200);
      expect((await call('get', superAdmin.cookie, '/referrals', { userId: user.id })).status).toBe(
        200,
      );

      expect(codeList).toHaveBeenLastCalledWith(
        expect.objectContaining({ select: expect.any(Object) }),
      );
      expect(codeDetail).toHaveBeenLastCalledWith(
        expect.objectContaining({ select: expect.any(Object) }),
      );
      expect(claimList).toHaveBeenLastCalledWith(
        expect.objectContaining({ select: expect.any(Object) }),
      );
      expect(referralList).toHaveBeenLastCalledWith(
        expect.objectContaining({ select: expect.any(Object) }),
      );
      const serializedArguments = JSON.stringify([
        codeList.mock.lastCall?.[0],
        codeDetail.mock.lastCall?.[0],
        claimList.mock.lastCall?.[0],
        referralList.mock.lastCall?.[0],
      ]);
      for (const forbidden of [
        'digest',
        'idempotencyKey',
        'responseSnapshot',
        'passwordHash',
        'authVersion',
        'username',
      ])
        expect(serializedArguments).not.toContain(`\"${forbidden}\":true`);
    } finally {
      codeList.mockRestore();
      codeDetail.mockRestore();
      claimList.mockRestore();
      referralList.mockRestore();
    }
  });
});

async function waitForExactAdvisoryWaiters(
  blocker: pg.Client,
  minimum: number,
  timeoutMs = 2_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const waiting = await blocker.query<{ count: number }>(
      `SELECT count(DISTINCT waiting.pid)::int AS count
         FROM pg_locks held
         JOIN pg_locks waiting
           ON waiting.locktype = 'advisory'
          AND waiting.database = held.database
          AND waiting.classid = held.classid
          AND waiting.objid = held.objid
          AND waiting.objsubid = held.objsubid
        WHERE held.pid = pg_backend_pid()
          AND held.locktype = 'advisory'
          AND held.granted
          AND NOT waiting.granted`,
    );
    if ((waiting.rows[0]?.count ?? 0) >= minimum) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}
