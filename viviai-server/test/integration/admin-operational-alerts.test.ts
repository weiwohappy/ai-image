import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';
import { adminApp, fixtureAdmin, fixtureJob } from '../helpers/admin.js';

/** Terminal jobs are only alerted on once the settlement notification has had time to arrive. */
const TERMINAL_GRACE_MS = 11 * 60_000;

describe('cross-module operational alerts', () => {
  let db: TestDatabase;
  let app: INestApplication;
  let owner: string;
  beforeAll(async () => {
    db = await createTestDatabase();
    app = await adminApp(db);
    owner = (await fixtureAdmin(db)).cookie;
  });
  afterAll(async () => {
    await app?.close();
    await db?.cleanup();
  });

  /**
   * The test schema is shared by every case in this file, so alerts are always matched by the
   * resource under test rather than by counting everything the projection produced.
   */
  async function alertsFor(kind: string, resourceId: string) {
    const response = await request(app.getHttpServer())
      .get(`/api/admin/alerts?status=active&source=${kind}`)
      .set('Cookie', owner);
    expect(response.status).toBe(200);
    return {
      body: response.body,
      rows: (response.body.data.rows as Array<{ resourceId: string }>).filter(
        (row) => row.resourceId === resourceId,
      ),
    };
  }
  const stored = (sourceKey: string) =>
    db.database.client.adminAlert.findUnique({ where: { sourceKey } });
  /** Prisma's raw statements run outside the suite's schema unless the path is set first. */
  async function settleItems(jobId: string, settledAt?: Date) {
    const schema = new URL(db.url).searchParams.get('schema')!;
    await db.database.transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('search_path',${schema},true)`;
      if (settledAt)
        await tx.$executeRaw`UPDATE "GenerationItem" SET status='failed', "updatedAt"=${settledAt} WHERE "jobId"=${jobId}::uuid`;
      else
        await tx.$executeRaw`UPDATE "GenerationItem" SET status='failed' WHERE "jobId"=${jobId}::uuid`;
    });
  }
  async function customer() {
    const id = randomUUID();
    await db.database.client.user.create({
      data: { id, email: `${id}@example.test`, username: id, passwordHash: 'unused' },
    });
    return id;
  }

  it('projects one alert per failed content publish and clears it once the resource publishes', async () => {
    const resourceId = randomUUID();
    const denial = await db.database.client.adminAuditEvent.create({
      data: {
        action: 'content.media.publish',
        outcome: 'denied',
        resourceId,
        reasonDigest: 'private-rejection-reason',
      },
    });
    const sourceKey = `content-publish:${denial.id}`;
    const first = await alertsFor('content_publish_failed', resourceId);
    expect(first.rows).toEqual([
      expect.objectContaining({
        category: 'service',
        kind: 'content_publish_failed',
        kindLabel: '内容发布失败',
        resourceId,
        resolved: false,
      }),
    ]);
    expect(JSON.stringify(first.body)).not.toContain('private-rejection-reason');
    expect((await stored(sourceKey))?.resolved).toBe(false);
    // Refreshing again must recognise the same denial instead of projecting a second alert.
    await alertsFor('content_publish_failed', resourceId);
    expect(await db.database.client.adminAlert.count({ where: { sourceKey } })).toBe(1);
    await db.database.client.adminAuditEvent.create({
      data: {
        action: 'content.media.publish',
        outcome: 'allowed',
        resourceId,
        createdAt: new Date(Date.now() + 1_000),
      },
    });
    await alertsFor('content_publish_failed', resourceId);
    expect((await stored(sourceKey))?.resolved).toBe(true);
  });

  it('projects terminal jobs that never notified and leaves settled ones inside the grace period alone', async () => {
    const job = await fixtureJob(db);
    await settleItems(job.id, new Date(Date.now() - TERMINAL_GRACE_MS));
    const fresh = await fixtureJob(db);
    await settleItems(fresh.id);
    const sourceKey = `notification-missing:${job.id}`;
    const rows = await alertsFor('notification_missing', job.id);
    expect(rows.rows).toEqual([
      expect.objectContaining({
        category: 'service',
        kind: 'notification_missing',
        kindLabel: '终态任务缺少通知',
        resourceId: job.id,
        jobId: job.id,
        resolved: false,
      }),
    ]);
    expect(JSON.stringify(rows.body)).not.toContain('customer-private-prompt');
    expect((await alertsFor('notification_missing', fresh.id)).rows).toEqual([]);
    expect((await stored(sourceKey))?.resourceId).toBe(job.id);
    await db.database.client.notification.create({
      data: {
        userId: job.userId,
        type: 'task',
        title: '任务失败',
        body: '图片生成失败。',
        eventKey: `generation-terminal:${job.id}`,
      },
    });
    await alertsFor('notification_missing', job.id);
    expect((await stored(sourceKey))?.resolved).toBe(true);
  });

  it('projects redemption codes whose used count drifted and clears the corrected code', async () => {
    const userId = await customer();
    const campaign = await db.database.client.redemptionCampaign.create({
      data: {
        name: 'alert-projection-campaign',
        startsAt: new Date(Date.now() - 3_600_000),
        endsAt: new Date(Date.now() + 3_600_000),
        credits: 100,
        totalLimit: 10,
      },
    });
    const drifted = await db.database.client.redemptionCode.create({
      data: {
        campaignId: campaign.id,
        digest: `digest-${randomUUID()}`,
        displayMask: 'VIVIAI-****-PRIVATE',
        maxUses: 5,
        usedCount: 3,
      },
    });
    const accurate = await db.database.client.redemptionCode.create({
      data: {
        campaignId: campaign.id,
        digest: `digest-${randomUUID()}`,
        displayMask: 'VIVIAI-****-ACCURATE',
        maxUses: 5,
        usedCount: 1,
      },
    });
    await db.database.client.redemptionClaim.createMany({
      data: [
        { userId, codeId: drifted.id, credits: 100, idempotencyKey: randomUUID() },
        { userId, codeId: accurate.id, credits: 100, idempotencyKey: randomUUID() },
      ],
    });
    const sourceKey = `redemption-count:${drifted.id}`;
    const rows = await alertsFor('redemption_count_mismatch', drifted.id);
    expect(rows.rows).toEqual([
      expect.objectContaining({
        category: 'service',
        kind: 'redemption_count_mismatch',
        kindLabel: '兑换码计数异常',
        resourceId: drifted.id,
        resolved: false,
      }),
    ]);
    expect(JSON.stringify(rows.body)).not.toContain('PRIVATE');
    expect(JSON.stringify(rows.body)).not.toContain(drifted.digest);
    expect(await stored(`redemption-count:${accurate.id}`)).toBeNull();
    await db.database.client.redemptionCode.update({
      where: { id: drifted.id },
      data: { usedCount: 1 },
    });
    await alertsFor('redemption_count_mismatch', drifted.id);
    expect((await stored(sourceKey))?.resolved).toBe(true);
  });

  it('projects settled batches that lost half their rows and clears them after a retry', async () => {
    const userId = await customer();
    const settled = (
      counts: {
        totalCount: number;
        succeededCount: number;
        failedCount: number;
        cancelledCount?: number;
      },
      retryOfRunId?: string,
    ) =>
      db.database.client.workflowRun.create({
        data: {
          userId,
          idempotencyKey: randomUUID(),
          workflowSnapshot: { prompts: ['customer-private-prompt'] },
          status: 'failed',
          cancelledCount: 0,
          ...(retryOfRunId ? { retryOfRunId } : {}),
          ...counts,
        },
      });
    const failing = await settled({ totalCount: 4, succeededCount: 2, failedCount: 2 });
    const belowThreshold = await settled({ totalCount: 3, succeededCount: 0, failedCount: 3 });
    const mostlyFine = await settled({ totalCount: 4, succeededCount: 3, failedCount: 1 });
    const sourceKey = `batch-failure:${failing.id}`;
    const rows = await alertsFor('batch_high_failure', failing.id);
    expect(rows.rows).toEqual([
      expect.objectContaining({
        category: 'service',
        kind: 'batch_high_failure',
        kindLabel: '批次失败率过高',
        resourceId: failing.id,
        resolved: false,
      }),
    ]);
    expect(JSON.stringify(rows.body)).not.toContain('customer-private-prompt');
    expect((await alertsFor('batch_high_failure', belowThreshold.id)).rows).toEqual([]);
    expect((await alertsFor('batch_high_failure', mostlyFine.id)).rows).toEqual([]);
    expect((await stored(sourceKey))?.resolved).toBe(false);
    // A retry is the product's own remedy, so the original batch stops alerting once it exists.
    await settled({ totalCount: 2, succeededCount: 2, failedCount: 0 }, failing.id);
    await alertsFor('batch_high_failure', failing.id);
    expect((await stored(sourceKey))?.resolved).toBe(true);
  });
});
