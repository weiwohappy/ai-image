import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';

describe('account engagement schema', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.cleanup();
  });

  it('persists one referral and one redemption claim per user and source', async () => {
    const db = database.database.client;
    const userInput = (name: string) => ({
      email: `${name}@example.test`,
      username: name,
      passwordHash: 'test-only-hash',
      inviteCode: name.toUpperCase().replaceAll('-', ''),
    });
    const inviter = await db.user.create({ data: userInput('invite-owner') });
    const invitee = await db.user.create({ data: userInput('invite-guest') });
    await db.referral.create({ data: { inviterUserId: inviter.id, inviteeUserId: invitee.id } });
    await expect(
      db.referral.create({ data: { inviterUserId: inviter.id, inviteeUserId: invitee.id } }),
    ).rejects.toMatchObject({ code: 'P2002' });

    const campaign = await db.redemptionCampaign.create({
      data: {
        name: 'Launch credits',
        startsAt: new Date('2026-09-12T00:00:00.000Z'),
        endsAt: new Date('2026-10-12T00:00:00.000Z'),
        credits: 100,
        totalLimit: 50,
      },
    });
    const code = await db.redemptionCode.create({
      data: { campaignId: campaign.id, digest: 'digest-one', displayMask: 'LAUNCH-****', maxUses: 50 },
    });
    await db.redemptionClaim.create({
      data: { userId: invitee.id, codeId: code.id, credits: 100, idempotencyKey: 'claim-one' },
    });
    await expect(
      db.redemptionClaim.create({
        data: { userId: invitee.id, codeId: code.id, credits: 100, idempotencyKey: 'claim-two' },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(
      db.redemptionClaim.create({
        data: { userId: inviter.id, codeId: code.id, credits: 100, idempotencyKey: 'claim-one' },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});
