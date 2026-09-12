import { randomUUID } from 'node:crypto';
import request from 'supertest';
import sharp from 'sharp';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadOfficialConfig } from '../../src/modules/providers/official-config.js';
import { adminApp, adminOrigin, fixtureAdmin } from '../helpers/admin.js';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';

const reason = 'Content operation approved for integration test';
const modelId = 'gemini-3.1-flash-image';
const outputSpecId = 'png-1k-1x1-v1';

function officialConfig() {
  return loadOfficialConfig({
    GEMINI_API_KEY: 'offline-admin-content-test',
    OFFICIAL_IMAGE_MODELS_JSON: JSON.stringify({
      revision: 'admin-content-v1',
      accounts: {
        google: {
          scope: 'admin-content-test',
          credentialVersion: 'test-v1',
          concurrency: 1,
          maxUnknown: 1,
          dailyBudgetMicros: '1000000',
        },
      },
      models: [
        {
          modelId,
          sales: { '1K': 30 },
          reserveCostMicros: '1000',
          pricing: {
            version: 'test-v1',
            currency: 'USD',
            rates: {
              input_text_tokens: '1',
              input_image_tokens: '1',
              output_text_tokens: '1',
              output_image_tokens: '1',
              thought_tokens: '1',
            },
          },
        },
      ],
    }),
  });
}

describe('admin operational content commands', () => {
  let db: TestDatabase;
  let app: Awaited<ReturnType<typeof adminApp>>;
  let operator: Awaited<ReturnType<typeof fixtureAdmin>>;
  let support: Awaited<ReturnType<typeof fixtureAdmin>>;
  let image: Buffer;

  const call = (
    method: 'get' | 'post' | 'patch',
    cookie: string,
    path: string,
    body: unknown = {},
    key = randomUUID(),
  ) =>
    request(app.getHttpServer())
      [method](`/api/admin/content${path}`)
      .set('Cookie', cookie)
      .set('Origin', adminOrigin)
      .set('Idempotency-Key', key)
      .send(body as object);

  const upload = (
    cookie = operator.cookie,
    key = randomUUID(),
    filename = 'cover.png',
    uploadReason = reason,
  ) =>
    request(app.getHttpServer())
      .post('/api/admin/content/media')
      .set('Cookie', cookie)
      .set('Origin', adminOrigin)
      .set('Idempotency-Key', key)
      .field('reason', uploadReason)
      .attach('file', image, { filename, contentType: 'image/png' });

  const inspiration = (externalId: string, mediaExternalId: string, sortOrder = 10) => ({
    externalId,
    title: `Title ${externalId}`,
    description: 'A complete operational content record',
    category: 'Portrait',
    editorialLabel: 'Featured',
    baseLikes: 7,
    tags: ['portrait'],
    defaultPrompt: 'A safe public prompt',
    defaultModelId: modelId,
    defaultOutputSpecId: outputSpecId,
    coverMediaExternalId: mediaExternalId,
    creatorName: 'Studio',
    sourceType: 'licensed',
    sourceName: 'Internal library',
    sourceUrl: 'https://example.test/source',
    status: 'draft' as const,
    sortOrder,
    reason,
  });

  beforeAll(async () => {
    db = await createTestDatabase();
    image = await sharp({ create: { width: 16, height: 12, channels: 3, background: '#336699' } })
      .png()
      .toBuffer();
    app = await adminApp(db, {
      nodeEnv: 'development',
      host: '127.0.0.1',
      officialImages: officialConfig(),
      simulationProviderEnabled: false,
    });
    operator = await fixtureAdmin(db, ['content_operator']);
    support = await fixtureAdmin(db, ['support']);
  });

  afterAll(async () => {
    await app.close();
    await db.cleanup();
  });

  it('gates uploads and replays one authoritative, sanitized receipt', async () => {
    const wrongOrigin = await request(app.getHttpServer())
      .post('/api/admin/content/media')
      .set('Cookie', operator.cookie)
      .set('Origin', 'https://evil.example')
      .set('Idempotency-Key', randomUUID())
      .field('reason', reason)
      .attach('file', image, { filename: 'evil.png', contentType: 'image/png' });
    expect(wrongOrigin.status).toBe(403);
    expect((await upload(support.cookie)).status).toBe(403);

    const key = randomUUID();
    const first = await upload(operator.cookie, key);
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({
      externalId: expect.stringMatching(/^content-media-/),
      filename: 'cover.png',
      contentType: 'image/png',
      status: 'draft',
      version: 1,
    });
    expect(first.body.data).not.toHaveProperty('objectKey');
    expect(first.body.data).not.toHaveProperty('createdByAdminId');
    const replay = await upload(operator.cookie, key);
    expect(replay.body.data).toEqual(first.body.data);
    expect(await db.database.client.contentMedia.count()).toBe(1);
    expect(await db.database.client.asset.count()).toBe(0);
    expect(
      await db.database.client.adminCommandReceipt.count({ where: { idempotencyKey: key } }),
    ).toBe(1);
    expect(
      await db.database.client.adminAuditEvent.count({
        where: { action: 'content.media.create', outcome: 'allowed' },
      }),
    ).toBe(1);
    expect((await upload(operator.cookie, key, 'changed.png')).body.code).toBe(
      'ADMIN_IDEMPOTENCY_CONFLICT',
    );
    const audit = JSON.stringify(
      await db.database.client.adminAuditEvent.findMany({
        where: { action: 'content.media.create' },
      }),
    );
    expect(audit).not.toContain(reason);
    expect(audit).not.toContain('content/admin/');
  });

  it('validates media and serves authenticated integrity-checked draft previews', async () => {
    const invalid = await request(app.getHttpServer())
      .post('/api/admin/content/media')
      .set('Cookie', operator.cookie)
      .set('Origin', adminOrigin)
      .set('Idempotency-Key', randomUUID())
      .field('reason', reason)
      .attach('file', Buffer.from('not an image'), {
        filename: 'bad.png',
        contentType: 'image/png',
      });
    expect(invalid.body.code).toBe('INVALID_IMAGE');
    const media = (await upload()).body.data;
    expect((await call('get', support.cookie, `/media/${media.id}`)).status).toBe(403);
    const metadata = await call('get', operator.cookie, `/media/${media.id}`);
    expect(metadata.body.data.previewUrl).toBe(`/api/admin/content/media/${media.id}/content`);
    const preview = await call('get', operator.cookie, `/media/${media.id}/content`);
    expect(preview.status).toBe(200);
    expect(preview.headers['cache-control']).toBe('private, no-store');
    expect(preview.headers.etag).toMatch(/^"[a-f0-9]{64}"$/);
    expect(Number(preview.headers['content-length'])).toBe(media.byteSize);
    expect(preview.headers['x-content-type-options']).toBe('nosniff');
  });

  it('creates, reads and updates inspirations with strict permission, input and version checks', async () => {
    const media = (await upload()).body.data;
    const body = inspiration(`admin-${randomUUID().slice(0, 8)}`, media.externalId);
    expect((await call('post', support.cookie, '/inspirations', body)).status).toBe(403);
    expect(
      (await call('post', operator.cookie, '/inspirations', { ...body, surprise: true })).status,
    ).toBe(400);
    const key = randomUUID();
    const created = await call('post', operator.cookie, '/inspirations', body, key);
    expect(created.body.data).toMatchObject({ version: 1, externalId: body.externalId });
    expect((await call('post', operator.cookie, '/inspirations', body, key)).body.data).toEqual(
      created.body.data,
    );
    expect(
      (await call('post', operator.cookie, '/inspirations', { ...body, title: 'Other' }, key)).body
        .code,
    ).toBe('ADMIN_IDEMPOTENCY_CONFLICT');
    expect((await call('get', operator.cookie, '/inspirations')).body.data.rows).toHaveLength(1);
    expect(
      (await call('get', operator.cookie, `/inspirations/${created.body.data.id}`)).body.data,
    ).toMatchObject({ externalId: body.externalId, title: body.title, version: 1 });

    const stale = await call('patch', operator.cookie, `/inspirations/${created.body.data.id}`, {
      ...body,
      title: 'Updated title',
      version: 2,
    });
    expect(stale.body.code).toBe('CONTENT_VERSION_CONFLICT');
    const updated = await call('patch', operator.cookie, `/inspirations/${created.body.data.id}`, {
      ...body,
      title: 'Updated title',
      version: 1,
    });
    expect(updated.body.data.version).toBe(2);
    const row = await db.database.client.inspiration.findUniqueOrThrow({
      where: { id: created.body.data.id },
    });
    expect(row.createdByAdminId).toBe(operator.account.id);
    expect(row.updatedByAdminId).toBe(operator.account.id);
  });

  it('publishes only after media, enabled model/spec and current price validate atomically', async () => {
    const media = (await upload()).body.data;
    const body = inspiration(`publish-${randomUUID().slice(0, 8)}`, media.externalId);
    const created = await call('post', operator.cookie, '/inspirations', body);
    const id = created.body.data.id;
    await call('post', operator.cookie, `/media/${media.id}/transition`, {
      version: 1,
      reason,
      status: 'published',
    });
    const noPrice = await call('post', operator.cookie, `/inspirations/${id}/transition`, {
      version: 1,
      reason,
      status: 'published',
    });
    expect(noPrice.status).toBe(422);
    expect(noPrice.body.code).toBe('CONTENT_NOT_PUBLISHABLE');
    expect(await db.database.client.inspiration.findUniqueOrThrow({ where: { id } })).toMatchObject(
      { status: 'draft', version: 1 },
    );
    await db.database.client.modelCreditPrice.create({
      data: { modelId, resolution: '1K', unitCredits: 30, enabled: true },
    });
    const published = await call('post', operator.cookie, `/inspirations/${id}/transition`, {
      version: 1,
      reason,
      status: 'published',
    });
    expect(published.body.data).toMatchObject({ version: 2, status: 'published' });
    const audit = await db.database.client.adminAuditEvent.findFirstOrThrow({
      where: { action: 'content.inspirations.publish', resourceId: id, outcome: 'allowed' },
    });
    expect(audit.reasonDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(audit.metadata).toMatchObject({
      contentKind: 'inspiration',
      changedFields: ['status'],
      beforeStatus: 'draft',
      afterStatus: 'published',
      beforeVersion: 1,
      afterVersion: 2,
    });
    expect(JSON.stringify(audit)).not.toContain(reason);
    expect(JSON.stringify(audit)).not.toContain(body.defaultPrompt);
    expect(JSON.stringify(audit)).not.toContain(body.sourceUrl);
  });

  it('rejects corrupted tool JSON and placeholders without a partial transition', async () => {
    const media = (await upload()).body.data;
    await call('post', operator.cookie, `/media/${media.id}/transition`, {
      version: 1,
      reason,
      status: 'published',
    });
    const created = await call('post', operator.cookie, '/tools', {
      externalId: `tool-${randomUUID().slice(0, 8)}`,
      name: 'Background cleaner',
      description: 'Removes a selected background',
      category: 'Editing',
      fields: [{ id: 'subject', label: 'Subject', type: 'text', required: true }],
      promptTemplate: 'Clean the background around {{subject}}',
      defaults: { modelId, resolution: '1K', ratio: '1:1', count: 1 },
      maxAssets: 1,
      maxOutputCount: 1,
      assetLabel: 'Reference image',
      defaultModelId: modelId,
      defaultOutputSpecId: outputSpecId,
      coverMediaExternalId: media.externalId,
      isNew: true,
      status: 'draft',
      sortOrder: 1,
      reason,
    });
    await db.database.client.toolDefinition.update({
      where: { id: created.body.data.id },
      data: {
        fieldSchema: [
          { id: 'subject', label: 'Subject', type: 'text', required: true },
          { id: 'subject', label: 'Duplicate', type: 'text', required: false },
        ],
        promptTemplate: 'Unknown {{missing}}',
      },
    });
    const failed = await call(
      'post',
      operator.cookie,
      `/tools/${created.body.data.id}/transition`,
      {
        version: 1,
        reason,
        status: 'published',
      },
    );
    expect(failed.status).toBe(422);
    expect(failed.body.code).toBe('CONTENT_NOT_PUBLISHABLE');
    expect(
      await db.database.client.toolDefinition.findUniqueOrThrow({
        where: { id: created.body.data.id },
      }),
    ).toMatchObject({ status: 'draft', version: 1 });
  });

  it('supports the frozen remix-template route and preserves versions for no-op updates', async () => {
    const media = (await upload()).body.data;
    const body = {
      externalId: `template-${randomUUID().slice(0, 8)}`,
      title: 'Campaign template',
      description: 'A complete remix template',
      category: 'Campaign',
      platform: 'Instagram',
      industry: 'Retail',
      style: 'Editorial',
      popularityLabel: 'Popular',
      baseRemixCount: 11,
      tags: ['campaign'],
      visualAnalysis: {
        composition: 'Centered subject',
        palette: ['#112233'],
        lighting: 'Soft',
        camera: 'Eye level',
        typographyZone: 'Top third',
        avoid: ['clutter'],
      },
      defaultPrompt: 'Create a campaign image',
      defaultParameters: { strength: 'balanced' },
      defaultModelId: modelId,
      defaultOutputSpecId: outputSpecId,
      coverMediaExternalId: media.externalId,
      status: 'draft',
      sortOrder: 3,
      reason,
    };
    const created = await call('post', operator.cookie, '/remix-templates', body);
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ externalId: body.externalId, version: 1 });
    const noOp = await call('patch', operator.cookie, `/remix-templates/${created.body.data.id}`, {
      ...body,
      version: 1,
    });
    expect(noOp.body.data.version).toBe(1);
    expect(
      (await call('get', operator.cookie, `/remix-templates/${created.body.data.id}`)).body.data,
    ).toMatchObject({ platform: 'Instagram', version: 1 });
  });

  it('serializes concurrent reorder commands and rejects stale versions atomically', async () => {
    const media = (await upload()).body.data;
    const first = await call(
      'post',
      operator.cookie,
      '/inspirations',
      inspiration(`sort-a-${randomUUID().slice(0, 8)}`, media.externalId, 1),
    );
    const second = await call(
      'post',
      operator.cookie,
      '/inspirations',
      inspiration(`sort-b-${randomUUID().slice(0, 8)}`, media.externalId, 2),
    );
    const items = [
      { id: first.body.data.id, version: 1, sortOrder: 20 },
      { id: second.body.data.id, version: 1, sortOrder: 10 },
    ];
    const [a, b] = await Promise.all([
      call('post', operator.cookie, '/inspirations/reorder', { reason, items }),
      call('post', operator.cookie, '/inspirations/reorder', { reason, items }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect([a.body.code, b.body.code]).toContain('CONTENT_VERSION_CONFLICT');
    const rows = await db.database.client.inspiration.findMany({
      where: { id: { in: items.map((item) => item.id) } },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    expect(rows.map((row) => [row.id, row.version, row.sortOrder])).toEqual([
      [second.body.data.id, 2, 10],
      [first.body.data.id, 2, 20],
    ]);
  });

  it('enforces lifecycle transitions for content and media archives', async () => {
    const media = (await upload()).body.data;
    const created = await call(
      'post',
      operator.cookie,
      '/inspirations',
      inspiration(`archive-${randomUUID().slice(0, 8)}`, media.externalId),
    );
    const archived = await call(
      'post',
      operator.cookie,
      `/inspirations/${created.body.data.id}/archive`,
      {
        version: 1,
        reason,
      },
    );
    expect(archived.body.data).toMatchObject({ status: 'archived', version: 2 });
    const invalid = await call(
      'post',
      operator.cookie,
      `/inspirations/${created.body.data.id}/transition`,
      {
        version: 2,
        reason,
        status: 'published',
      },
    );
    expect(invalid.body.code).toBe('CONTENT_INVALID_TRANSITION');
    const mediaArchived = await call('post', operator.cookie, `/media/${media.id}/archive`, {
      version: 1,
      reason,
    });
    expect(mediaArchived.body.data).toMatchObject({ status: 'archived', version: 2 });
  });

  it('serializes publication against media offlining and preserves public reachability', async () => {
    await db.database.client.modelCreditPrice.upsert({
      where: { modelId_resolution: { modelId, resolution: '1K' } },
      create: { modelId, resolution: '1K', unitCredits: 30, enabled: true },
      update: { unitCredits: 30, enabled: true },
    });
    const media = (await upload()).body.data;
    await call('post', operator.cookie, `/media/${media.id}/transition`, {
      version: 1,
      reason,
      status: 'published',
    });
    const created = await call(
      'post',
      operator.cookie,
      '/inspirations',
      inspiration(`media-race-${randomUUID().slice(0, 8)}`, media.externalId),
    );
    const [publish, offline] = await Promise.all([
      call('post', operator.cookie, `/inspirations/${created.body.data.id}/transition`, {
        version: 1,
        reason,
        status: 'published',
      }),
      call('post', operator.cookie, `/media/${media.id}/transition`, {
        version: 2,
        reason,
        status: 'offline',
      }),
    ]);
    expect([publish.status, offline.status].sort()).toEqual([201, 422]);
    const finalContent = await db.database.client.inspiration.findUniqueOrThrow({
      where: { id: created.body.data.id },
    });
    const finalMedia = await db.database.client.contentMedia.findUniqueOrThrow({
      where: { id: media.id },
    });
    expect(finalContent.status !== 'published' || finalMedia.status === 'published').toBe(true);
  });

  it('reauthorizes inside a blocked command before performing work', async () => {
    const key = randomUUID();
    const blocker = new pg.Client({ connectionString: db.url });
    await blocker.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `admin:content-command:${operator.account.id}:${key}`,
    ]);
    const before = await db.database.client.contentMedia.count();
    const pending = upload(operator.cookie, key, 'reauthorize.png').then((response) => response);
    const deadline = Date.now() + 2_000;
    let observedWaiter = false;
    while (Date.now() < deadline) {
      const waiting = await blocker.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND wait_event = 'advisory'`,
      );
      if ((waiting.rows[0]?.count ?? 0) > 0) {
        observedWaiter = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(observedWaiter).toBe(true);
    await db.database.client.adminAccountRole.delete({
      where: { accountId_roleKey: { accountId: operator.account.id, roleKey: 'content_operator' } },
    });
    await blocker.query('COMMIT');
    await blocker.end();
    const response = await pending;
    expect(response.status).toBe(401);
    expect(await db.database.client.contentMedia.count()).toBe(before);
    expect(
      await db.database.client.adminCommandReceipt.count({ where: { idempotencyKey: key } }),
    ).toBe(0);
  });
});
