import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import sharp from 'sharp';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadOfficialConfig } from '../../src/modules/providers/official-config.js';
import type { ThirdPartyImageConfig } from '../../src/modules/providers/third-party-config.js';
import { ASSET_STORE } from '../../src/modules/assets/assets.service.js';
import type { ObjectStore } from '../../src/modules/assets/object-store.js';
import { DatabaseService } from '../../src/shared/database/database.service.js';
import { adminApp, adminOrigin, fixtureAdmin } from '../helpers/admin.js';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';
import { contentSeedManifest, seedContent } from '../../src/scripts/seed-content.js';
import { validateImage } from '../../src/modules/assets/image-validation.js';

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

function thirdPartyConfig(): ThirdPartyImageConfig {
  return {
    id: 'sub2api',
    kind: 'third_party',
    baseUrl: 'https://images.example.test/v1',
    apiKey: 'offline-third-party-admin-content-test',
    scope: 'admin-content-third-party',
    credentialVersion: 'test-v1',
    concurrency: 1,
    maxUnknown: 1,
    dailyBudgetMicros: '1000000',
    revision: 'admin-content-third-party-v1',
    models: [
      {
        modelId: 'gpt-image-2',
        enabledResolutions: ['1K'],
        reserveCostMicros: '1000',
        pricing: {
          version: 'test-v1',
          currency: 'USD',
          rates: {
            input_text_tokens: '1',
            input_image_tokens: '1',
            output_image_tokens: '1',
          },
        },
      },
    ],
  };
}

describe('admin operational content commands', () => {
  let db: TestDatabase;
  let app: Awaited<ReturnType<typeof adminApp>>;
  let operator: Awaited<ReturnType<typeof fixtureAdmin>>;
  let superAdmin: Awaited<ReturnType<typeof fixtureAdmin>>;
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
    sourceType: 'licensed-user',
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
      thirdPartyImages: thirdPartyConfig(),
      simulationProviderEnabled: false,
    });
    operator = await fixtureAdmin(db, ['content_operator']);
    superAdmin = await fixtureAdmin(db, ['super_admin']);
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

  it.each(['upload', 'team'] as const)(
    'serializes cross-domain receipt writers when %s queues first',
    async (firstKind) => {
      const key = randomUUID();
      const roleKey = `custom_receipt_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      const store = app.get<ObjectStore>(ASSET_STORE);
      const normalized = await validateImage(image);
      const mediaId = deterministicTestMediaId(superAdmin.account.id, key);
      const sha256 = createHash('sha256').update(normalized.bytes).digest('hex');
      const expectedObjectKey = `content/admin/${mediaId}-${sha256}.png`;
      const blocker = new pg.Client({ connectionString: db.url });
      await blocker.connect();
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `admin:command-receipt:${superAdmin.account.id}:${key}`,
      ]);
      const team = () =>
        request(app.getHttpServer())
          .post('/api/admin/team/roles')
          .set('Cookie', superAdmin.cookie)
          .set('Origin', adminOrigin)
          .set('Idempotency-Key', key)
          .send({
            key: roleKey,
            name: 'Receipt race role',
            description: 'Exercises the shared receipt lock',
            permissions: ['dashboard.read'],
            reason,
          });
      const media = () => upload(superAdmin.cookie, key, 'receipt-race.png');
      const start = (kind: 'upload' | 'team') =>
        (kind === 'upload' ? media() : team()).then((response) => response);
      const first = start(firstKind);
      let second: ReturnType<typeof start> | undefined;
      try {
        expect(await waitForExactAdvisoryWaiters(blocker, 1)).toBe(true);
        second = start(firstKind === 'upload' ? 'team' : 'upload');
        expect(await waitForExactAdvisoryWaiters(blocker, 2)).toBe(true);
        await blocker.query('COMMIT');
        const [firstResponse, secondResponse] = await Promise.all([first, second]);
        expect(firstResponse.status).toBe(201);
        expect(secondResponse.status).toBe(409);
        expect(secondResponse.body.code).toBe('ADMIN_IDEMPOTENCY_CONFLICT');
        const receipt = await db.database.client.adminCommandReceipt.findUniqueOrThrow({
          where: {
            accountId_idempotencyKey: {
              accountId: superAdmin.account.id,
              idempotencyKey: key,
            },
          },
        });
        expect(receipt.action).toBe(
          firstKind === 'upload' ? 'content.media.create' : 'team.role.create',
        );
        const row = await db.database.client.contentMedia.findUnique({ where: { id: mediaId } });
        const role = await db.database.client.adminRole.findUnique({ where: { key: roleKey } });
        if (firstKind === 'upload') {
          expect(row).toMatchObject({ objectKey: expectedObjectKey, sha256 });
          expect(role).toBeNull();
          expect(Buffer.from(await store.get(expectedObjectKey))).toEqual(
            Buffer.from(normalized.bytes),
          );
        } else {
          expect(row).toBeNull();
          expect(role).toMatchObject({ key: roleKey });
          await expect(store.get(expectedObjectKey)).rejects.toBeDefined();
        }
      } finally {
        await blocker.query('ROLLBACK').catch(() => undefined);
        await blocker.end();
        await Promise.allSettled([first, ...(second ? [second] : [])]);
        await store.delete(expectedObjectKey).catch(() => undefined);
        await db.database.client.adminCommandReceipt.deleteMany({
          where: { accountId: superAdmin.account.id, idempotencyKey: key },
        });
        await db.database.client.contentMedia.deleteMany({ where: { id: mediaId } });
        await db.database.client.adminRole.deleteMany({ where: { key: roleKey } });
        expect(
          await db.database.client.adminCommandReceipt.count({
            where: { accountId: superAdmin.account.id, idempotencyKey: key },
          }),
        ).toBe(0);
        expect(await db.database.client.contentMedia.count({ where: { id: mediaId } })).toBe(0);
        await expect(store.get(expectedObjectKey)).rejects.toBeDefined();
      }
    },
    30_000,
  );

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

  it('returns bindable safe field details when media cannot be published', async () => {
    const media = (await upload()).body.data;
    const row = await db.database.client.contentMedia.findUniqueOrThrow({
      where: { id: media.id },
    });
    await app.get<ObjectStore>(ASSET_STORE).delete(row.objectKey);
    const response = await call('post', operator.cookie, `/media/${media.id}/transition`, {
      version: 1,
      reason,
      status: 'published',
    });
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      code: 'CONTENT_NOT_PUBLISHABLE',
      field: 'media',
      details: { reason: 'not_publishable' },
    });
    expect(JSON.stringify(response.body)).not.toContain(row.objectKey);
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
    expect(noPrice.body.field).toBe('defaultModelId');
    expect(noPrice.body.details).toEqual({ reason: 'not_publishable' });
    expect(JSON.stringify(noPrice.body)).not.toContain(modelId);
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
    const publicList = await request(app.getHttpServer()).get(
      '/api/inspirations?category=Portrait',
    );
    expect(publicList.status).toBe(200);
    expect(publicList.body.data.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: body.externalId })]),
    );
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
      sourceType: 'platform',
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
    await call('post', operator.cookie, `/media/${media.id}/transition`, {
      version: 1,
      reason,
      status: 'published',
    });
    await db.database.client.modelCreditPrice.upsert({
      where: { modelId_resolution: { modelId, resolution: '1K' } },
      create: { modelId, resolution: '1K', unitCredits: 30, enabled: true },
      update: { unitCredits: 30, enabled: true },
    });
    const published = await call(
      'post',
      operator.cookie,
      `/remix-templates/${created.body.data.id}/transition`,
      { version: 1, reason, status: 'published' },
    );
    expect(published.status).toBe(201);
    const publicDetail = await request(app.getHttpServer()).get(
      `/api/remix-templates/${body.externalId}`,
    );
    expect(publicDetail.status).toBe(200);
    expect(publicDetail.body.data).toMatchObject({ id: body.externalId, sourceType: 'platform' });
  });

  it('publishes a tool executable through the configured third-party image channel', async () => {
    const media = (await upload()).body.data;
    await call('post', operator.cookie, `/media/${media.id}/transition`, {
      version: 1,
      reason,
      status: 'published',
    });
    await db.database.client.modelCreditPrice.upsert({
      where: { modelId_resolution: { modelId: 'gpt-image-2', resolution: '1K' } },
      create: { modelId: 'gpt-image-2', resolution: '1K', unitCredits: 45, enabled: true },
      update: { unitCredits: 45, enabled: true },
    });
    const externalId = `third-party-tool-${randomUUID().slice(0, 8)}`;
    const created = await call('post', operator.cookie, '/tools', {
      externalId,
      name: 'Third-party executable tool',
      description: 'Uses the configured OpenAI-compatible image route',
      category: 'Editing',
      fields: [{ id: 'subject', label: 'Subject', type: 'text', required: true }],
      promptTemplate: 'Render {{subject}}',
      defaults: { modelId: 'gpt-image-2', resolution: '1K', ratio: '1:1', count: 1 },
      maxAssets: 2,
      maxOutputCount: 1,
      assetLabel: 'References',
      defaultModelId: 'gpt-image-2',
      defaultOutputSpecId: outputSpecId,
      coverMediaExternalId: media.externalId,
      status: 'draft',
      sortOrder: 2,
      reason,
    });
    expect(created.status).toBe(201);
    const published = await call(
      'post',
      operator.cookie,
      `/tools/${created.body.data.id}/transition`,
      {
        version: 1,
        reason,
        status: 'published',
      },
    );
    expect(published.status).toBe(201);
    const publicDetail = await request(app.getHttpServer()).get(`/api/tools/${externalId}`);
    expect(publicDetail.status).toBe(200);
    expect(publicDetail.body.data).toMatchObject({ id: externalId, maxAssets: 2 });
  });

  it('stores an unready draft tool but enforces current model image capacity at publish', async () => {
    await db.database.client.authRateBucket.deleteMany({
      where: { key: { startsWith: 'admin-content-publish:' } },
    });
    const media = (await upload()).body.data;
    await call('post', operator.cookie, `/media/${media.id}/transition`, {
      version: 1,
      reason,
      status: 'published',
    });
    await db.database.client.modelCreditPrice.upsert({
      where: { modelId_resolution: { modelId, resolution: '1K' } },
      create: { modelId, resolution: '1K', unitCredits: 30, enabled: true },
      update: { unitCredits: 30, enabled: true },
    });
    const created = await call('post', operator.cookie, '/tools', {
      externalId: `unready-draft-${randomUUID().slice(0, 8)}`,
      name: 'Unready draft tool',
      description: 'Keeps editorial configuration while runtime capability is not ready',
      category: 'Editing',
      fields: [{ id: 'subject', label: 'Subject', type: 'text', required: true }],
      promptTemplate: 'Render {{subject}}',
      defaults: { modelId, resolution: '1K', ratio: '1:1', count: 1 },
      maxAssets: 3,
      maxOutputCount: 1,
      assetLabel: 'References',
      defaultModelId: modelId,
      defaultOutputSpecId: outputSpecId,
      coverMediaExternalId: media.externalId,
      status: 'draft',
      sortOrder: 4,
      reason,
    });
    expect(created.status).toBe(201);
    const publish = await call(
      'post',
      operator.cookie,
      `/tools/${created.body.data.id}/transition`,
      { version: 1, reason, status: 'published' },
    );
    expect(publish.status).toBe(422);
    expect(publish.body).toMatchObject({
      code: 'CONTENT_NOT_PUBLISHABLE',
      field: 'maxAssets',
      details: { reason: 'not_publishable' },
    });
    expect(
      await db.database.client.toolDefinition.findUniqueOrThrow({
        where: { id: created.body.data.id },
      }),
    ).toMatchObject({ status: 'draft', version: 1, maxAssets: 3 });
  });

  it('requires publish permission to change an already-published record', async () => {
    await db.database.client.authRateBucket.deleteMany({
      where: { key: { startsWith: 'admin-content-publish:' } },
    });
    const roleKey = `writer-${randomUUID().slice(0, 8)}`;
    await db.database.client.adminRole.create({
      data: {
        key: roleKey,
        name: 'Content writer without publish',
        permissions: ['dashboard.read', 'content.inspirations.read', 'content.inspirations.write'],
      },
    });
    const writer = await fixtureAdmin(db, [roleKey]);
    const media = (await upload()).body.data;
    await call('post', operator.cookie, `/media/${media.id}/transition`, {
      version: 1,
      reason,
      status: 'published',
    });
    await db.database.client.modelCreditPrice.upsert({
      where: { modelId_resolution: { modelId, resolution: '1K' } },
      create: { modelId, resolution: '1K', unitCredits: 30, enabled: true },
      update: { unitCredits: 30, enabled: true },
    });
    const body = inspiration(`published-write-${randomUUID().slice(0, 8)}`, media.externalId);
    const created = await call('post', operator.cookie, '/inspirations', body);
    const published = await call(
      'post',
      operator.cookie,
      `/inspirations/${created.body.data.id}/transition`,
      { version: 1, reason, status: 'published' },
    );
    const denied = await call('patch', writer.cookie, `/inspirations/${created.body.data.id}`, {
      ...body,
      title: 'Writer must not alter public content',
      status: 'published',
      version: published.body.data.version,
    });
    expect(denied.status).toBe(403);
    expect(
      await db.database.client.inspiration.findUniqueOrThrow({
        where: { id: created.body.data.id },
      }),
    ).toMatchObject({ title: body.title, version: published.body.data.version });
  });

  it('requires publish permission when a reorder mixes published and draft records', async () => {
    await db.database.client.authRateBucket.deleteMany({
      where: { key: { startsWith: 'admin-content-publish:' } },
    });
    const roleKey = `reorder-writer-${randomUUID().slice(0, 8)}`;
    await db.database.client.adminRole.create({
      data: {
        key: roleKey,
        name: 'Content reorder writer without publish',
        permissions: ['dashboard.read', 'content.inspirations.read', 'content.inspirations.write'],
      },
    });
    const writer = await fixtureAdmin(db, [roleKey]);
    const media = (await upload()).body.data;
    await call('post', operator.cookie, `/media/${media.id}/transition`, {
      version: 1,
      reason,
      status: 'published',
    });
    await db.database.client.modelCreditPrice.upsert({
      where: { modelId_resolution: { modelId, resolution: '1K' } },
      create: { modelId, resolution: '1K', unitCredits: 30, enabled: true },
      update: { unitCredits: 30, enabled: true },
    });
    const publishedBody = inspiration(
      `reorder-published-${randomUUID().slice(0, 8)}`,
      media.externalId,
      1,
    );
    const draftBody = inspiration(`reorder-draft-${randomUUID().slice(0, 8)}`, media.externalId, 2);
    const publishedDraft = await call('post', operator.cookie, '/inspirations', publishedBody);
    const draft = await call('post', operator.cookie, '/inspirations', draftBody);
    const published = await call(
      'post',
      operator.cookie,
      `/inspirations/${publishedDraft.body.data.id}/transition`,
      { version: 1, reason, status: 'published' },
    );
    const denied = await call('post', writer.cookie, '/inspirations/reorder', {
      reason,
      items: [
        { id: published.body.data.id, version: 2, sortOrder: 20 },
        { id: draft.body.data.id, version: 1, sortOrder: 10 },
      ],
    });
    expect(denied.status).toBe(403);
    expect(
      await db.database.client.inspiration.findMany({
        where: { id: { in: [published.body.data.id, draft.body.data.id] } },
        orderBy: { id: 'asc' },
        select: { id: true, sortOrder: true, version: true },
      }),
    ).toEqual(
      [
        { id: published.body.data.id, sortOrder: 1, version: 2 },
        { id: draft.body.data.id, sortOrder: 2, version: 1 },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    );
  });

  it('paginates filtered admin content and media without gaps or duplicates', async () => {
    const mediaIds: string[] = [];
    const contentIds: string[] = [];
    for (let index = 0; index < 4; index++) {
      const media = (await upload(operator.cookie, randomUUID(), `page-${index}.png`)).body.data;
      mediaIds.push(media.id);
      const mediaExternalId = `page-media-${index}-${randomUUID().slice(0, 8)}`;
      await db.database.client.contentMedia.update({
        where: { id: media.id },
        data: { externalId: mediaExternalId },
      });
      const created = await call(
        'post',
        operator.cookie,
        '/inspirations',
        inspiration(`page-${index}-${randomUUID().slice(0, 8)}`, mediaExternalId, index),
      );
      contentIds.push(created.body.data.id);
    }
    const tiedAt = new Date();
    await db.database.client.inspiration.updateMany({
      where: { id: { in: contentIds } },
      data: { updatedAt: tiedAt },
    });
    const seen = new Set<string>();
    let cursor: string | null = null;
    let firstCursor: string | null = null;
    do {
      const params = new URLSearchParams({
        limit: '2',
        status: 'draft',
        tag: 'portrait',
        q: 'page-',
        updatedFrom: new Date(tiedAt.getTime() - 1_000).toISOString(),
        updatedTo: new Date(tiedAt.getTime() + 1_000).toISOString(),
      });
      if (cursor) params.set('cursor', cursor);
      const page = await call('get', operator.cookie, `/inspirations?${params}`);
      expect(page.status).toBe(200);
      for (const row of page.body.data.rows) {
        expect(seen.has(row.id)).toBe(false);
        seen.add(row.id);
      }
      cursor = page.body.data.nextCursor;
      firstCursor ??= cursor;
    } while (cursor);
    expect(seen).toEqual(new Set(contentIds));
    const foreignFilters = await call(
      'get',
      operator.cookie,
      `/inspirations?limit=2&status=published&cursor=${encodeURIComponent(firstCursor!)}`,
    );
    expect(foreignFilters.status).toBe(400);

    const after = new Date(Date.now() - 60_000).toISOString();
    const mediaPage = await call(
      'get',
      operator.cookie,
      `/media?limit=2&status=draft&q=page-media-&updatedFrom=${encodeURIComponent(after)}`,
    );
    expect(mediaPage.status).toBe(200);
    expect(mediaPage.body.data.rows).toHaveLength(2);
    expect(mediaPage.body.data.nextCursor).toEqual(expect.any(String));
    expect(mediaPage.body.data.rows.every((row: { id: string }) => mediaIds.includes(row.id))).toBe(
      true,
    );
    expect((await call('get', operator.cookie, '/inspirations?limit=51')).status).toBe(400);
  });

  it('rate-limits publish attempts by actor, IP and action and recovers after expiry', async () => {
    await db.database.client.authRateBucket.deleteMany({
      where: { key: { startsWith: 'admin-content-publish:' } },
    });
    const second = await fixtureAdmin(db, ['content_operator']);
    const media = (await upload()).body.data;
    await call('post', operator.cookie, `/media/${media.id}/transition`, {
      version: 1,
      reason,
      status: 'published',
    });
    await db.database.client.modelCreditPrice.upsert({
      where: { modelId_resolution: { modelId, resolution: '1K' } },
      create: { modelId, resolution: '1K', unitCredits: 30, enabled: true },
      update: { unitCredits: 30, enabled: true },
    });
    const ids: string[] = [];
    for (let index = 0; index < 6; index++) {
      const body = inspiration(`rate-${index}-${randomUUID().slice(0, 8)}`, media.externalId);
      ids.push((await call('post', operator.cookie, '/inspirations', body)).body.data.id);
    }
    const statuses = [];
    for (const id of ids)
      statuses.push(
        (
          await call('post', operator.cookie, `/inspirations/${id}/transition`, {
            version: 1,
            reason,
            status: 'published',
          })
        ).status,
      );
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
    const isolated = await call('post', second.cookie, `/inspirations/${ids[5]}/transition`, {
      version: 1,
      reason,
      status: 'published',
    });
    expect(isolated.status).toBe(201);
    await db.database.client.authRateBucket.updateMany({
      where: { key: { startsWith: `admin-content-publish:${operator.account.id}:` } },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    const recoveryBody = inspiration(`rate-recovery-${randomUUID().slice(0, 8)}`, media.externalId);
    const recovery = await call('post', operator.cookie, '/inspirations', recoveryBody);
    expect(
      (
        await call('post', operator.cookie, `/inspirations/${recovery.body.data.id}/transition`, {
          version: 1,
          reason,
          status: 'published',
        })
      ).status,
    ).toBe(201);
    await db.database.client.authRateBucket.deleteMany({
      where: { key: { startsWith: 'admin-content-publish:' } },
    });
  });

  it('does not consume publish quota before the write gate and permissions succeed', async () => {
    await db.database.client.authRateBucket.deleteMany({
      where: { key: { startsWith: 'admin-content-publish:' } },
    });
    const media = (await upload()).body.data;
    const created = await call(
      'post',
      operator.cookie,
      '/inspirations',
      inspiration(`quota-gate-${randomUUID().slice(0, 8)}`, media.externalId),
    );
    const roleKey = `quota-writer-${randomUUID().slice(0, 8)}`;
    await db.database.client.adminRole.create({
      data: {
        key: roleKey,
        name: 'Quota writer without publish',
        permissions: ['dashboard.read', 'content.inspirations.read', 'content.inspirations.write'],
      },
    });
    const writer = await fixtureAdmin(db, [roleKey]);
    const denied = await call(
      'post',
      writer.cookie,
      `/inspirations/${created.body.data.id}/transition`,
      { version: 1, reason, status: 'published' },
    );
    expect(denied.status).toBe(403);

    const gated = await adminApp(db, {
      nodeEnv: 'test',
      host: '127.0.0.1',
      officialImages: officialConfig(),
      thirdPartyImages: thirdPartyConfig(),
      simulationProviderEnabled: false,
    });
    try {
      const disabled = await request(gated.getHttpServer())
        .post(`/api/admin/content/inspirations/${created.body.data.id}/transition`)
        .set('Cookie', operator.cookie)
        .set('Origin', adminOrigin)
        .set('Idempotency-Key', randomUUID())
        .send({ version: 1, reason, status: 'published' });
      expect(disabled.status).toBe(503);
    } finally {
      await gated.close();
    }
    expect(
      await db.database.client.authRateBucket.count({
        where: { key: { startsWith: 'admin-content-publish:' } },
      }),
    ).toBe(0);
  });

  it('durably counts authorized invalid publish attempts after business rollback', async () => {
    await db.database.client.authRateBucket.deleteMany({
      where: { key: { startsWith: 'admin-content-publish:' } },
    });
    const media = (await upload()).body.data;
    const created = await call(
      'post',
      operator.cookie,
      '/inspirations',
      inspiration(`quota-invalid-${randomUUID().slice(0, 8)}`, media.externalId),
    );
    const statuses: number[] = [];
    for (let index = 0; index < 6; index++)
      statuses.push(
        (
          await call(
            'post',
            operator.cookie,
            `/inspirations/${created.body.data.id}/transition`,
            { version: 1, reason, status: 'published' },
            randomUUID(),
          )
        ).status,
      );
    expect(statuses).toEqual([422, 422, 422, 422, 422, 429]);
    expect(
      await db.database.client.inspiration.findUniqueOrThrow({
        where: { id: created.body.data.id },
      }),
    ).toMatchObject({ status: 'draft', version: 1 });
    const second = await fixtureAdmin(db, ['content_operator']);
    expect(
      (
        await call(
          'post',
          second.cookie,
          `/inspirations/${created.body.data.id}/transition`,
          { version: 1, reason, status: 'published' },
          randomUUID(),
        )
      ).status,
    ).toBe(422);
    const buckets = await db.database.client.authRateBucket.findMany({
      where: { key: { startsWith: 'admin-content-publish:' } },
    });
    expect(
      buckets.find((bucket) =>
        bucket.key.startsWith(
          `admin-content-publish:${operator.account.id}:content.inspirations.publish`,
        ),
      )?.count,
    ).toBe(6);
    expect(
      buckets.find((bucket) =>
        bucket.key.startsWith(
          `admin-content-publish:${second.account.id}:content.inspirations.publish`,
        ),
      )?.count,
    ).toBe(1);
    expect(
      buckets.find(
        (bucket) =>
          bucket.key.startsWith('admin-content-publish:ip:') &&
          bucket.key.endsWith(':content.inspirations.publish'),
      )?.count,
    ).toBe(7);
  });

  it('retains publish quota across version conflicts and infrastructure rollback', async () => {
    await db.database.client.authRateBucket.deleteMany({
      where: { key: { startsWith: 'admin-content-publish:' } },
    });
    const media = (await upload()).body.data;
    await call('post', operator.cookie, `/media/${media.id}/transition`, {
      version: 1,
      reason,
      status: 'published',
    });
    await db.database.client.modelCreditPrice.upsert({
      where: { modelId_resolution: { modelId, resolution: '1K' } },
      create: { modelId, resolution: '1K', unitCredits: 30, enabled: true },
      update: { unitCredits: 30, enabled: true },
    });
    const created = await call(
      'post',
      operator.cookie,
      '/inspirations',
      inspiration(`quota-rollback-${randomUUID().slice(0, 8)}`, media.externalId),
    );
    await db.database.client.authRateBucket.deleteMany({
      where: { key: { startsWith: 'admin-content-publish:' } },
    });
    const conflict = await call(
      'post',
      operator.cookie,
      `/inspirations/${created.body.data.id}/transition`,
      { version: 2, reason, status: 'published' },
      randomUUID(),
    );
    expect(conflict.status).toBe(409);
    const constraint = `test_publish_rollback_${randomUUID().replaceAll('-', '')}`;
    const schema = new URL(db.url).searchParams.get('schema')!;
    try {
      await db.database.client.$executeRawUnsafe(
        `ALTER TABLE "${schema}"."inspirations" ADD CONSTRAINT "${constraint}" CHECK ("id" <> '${created.body.data.id}'::uuid OR "status" <> 'published')`,
      );
      const failed = await call(
        'post',
        operator.cookie,
        `/inspirations/${created.body.data.id}/transition`,
        { version: 1, reason, status: 'published' },
        randomUUID(),
      );
      expect(failed.status).toBe(500);
    } finally {
      await db.database.client.$executeRawUnsafe(
        `ALTER TABLE "${schema}"."inspirations" DROP CONSTRAINT IF EXISTS "${constraint}"`,
      );
    }
    expect(
      await db.database.client.authRateBucket.findFirstOrThrow({
        where: {
          key: {
            startsWith: `admin-content-publish:${operator.account.id}:content.inspirations.publish`,
          },
        },
      }),
    ).toMatchObject({ count: 2 });
    expect(
      await db.database.client.inspiration.findUniqueOrThrow({
        where: { id: created.body.data.id },
      }),
    ).toMatchObject({ status: 'draft', version: 1 });
  });

  it('replays an exact publish receipt after quota is exhausted without charging again', async () => {
    await db.database.client.authRateBucket.deleteMany({
      where: { key: { startsWith: 'admin-content-publish:' } },
    });
    const media = (await upload()).body.data;
    await call('post', operator.cookie, `/media/${media.id}/transition`, {
      version: 1,
      reason,
      status: 'published',
    });
    await db.database.client.modelCreditPrice.upsert({
      where: { modelId_resolution: { modelId, resolution: '1K' } },
      create: { modelId, resolution: '1K', unitCredits: 30, enabled: true },
      update: { unitCredits: 30, enabled: true },
    });
    const ids: string[] = [];
    for (let index = 0; index < 5; index++) {
      const created = await call(
        'post',
        operator.cookie,
        '/inspirations',
        inspiration(`quota-replay-${index}-${randomUUID().slice(0, 8)}`, media.externalId),
      );
      ids.push(created.body.data.id);
    }
    const replayKey = randomUUID();
    const publishBody = { version: 1, reason, status: 'published' };
    const first = await call(
      'post',
      operator.cookie,
      `/inspirations/${ids[0]}/transition`,
      publishBody,
      replayKey,
    );
    expect(first.status).toBe(201);
    for (const id of ids.slice(1))
      expect(
        (await call('post', operator.cookie, `/inspirations/${id}/transition`, publishBody)).status,
      ).toBe(201);
    const replay = await call(
      'post',
      operator.cookie,
      `/inspirations/${ids[0]}/transition`,
      publishBody,
      replayKey,
    );
    expect(replay.status).toBe(201);
    expect(replay.body.data).toEqual(first.body.data);
    expect(
      await db.database.client.adminAuditEvent.count({
        where: {
          action: 'content.inspirations.publish',
          resourceId: ids[0]!,
          outcome: 'allowed',
        },
      }),
    ).toBe(1);
    expect(
      await db.database.client.authRateBucket.findFirstOrThrow({
        where: {
          key: {
            startsWith: `admin-content-publish:${operator.account.id}:content.inspirations.publish`,
          },
        },
      }),
    ).toMatchObject({ count: 5 });
  });

  it('rate-limits published PATCH and reorder mutations independently of idempotency keys', async () => {
    await db.database.client.authRateBucket.deleteMany({
      where: { key: { startsWith: 'admin-content-publish:' } },
    });
    const media = (await upload()).body.data;
    await call('post', operator.cookie, `/media/${media.id}/transition`, {
      version: 1,
      reason,
      status: 'published',
    });
    await db.database.client.modelCreditPrice.upsert({
      where: { modelId_resolution: { modelId, resolution: '1K' } },
      create: { modelId, resolution: '1K', unitCredits: 30, enabled: true },
      update: { unitCredits: 30, enabled: true },
    });
    const body = inspiration(`quota-mutation-${randomUUID().slice(0, 8)}`, media.externalId);
    const created = await call('post', operator.cookie, '/inspirations', body);
    const published = await call(
      'post',
      operator.cookie,
      `/inspirations/${created.body.data.id}/transition`,
      { version: 1, reason, status: 'published' },
    );
    expect(published.status).toBe(201);
    await db.database.client.authRateBucket.deleteMany({
      where: { key: { startsWith: 'admin-content-publish:' } },
    });

    let version = 2;
    const patchStatuses: number[] = [];
    for (let index = 0; index < 6; index++) {
      const response = await call(
        'patch',
        operator.cookie,
        `/inspirations/${created.body.data.id}`,
        {
          ...body,
          title: `Published edit ${index}`,
          status: 'published',
          version,
        },
      );
      patchStatuses.push(response.status);
      if (response.status === 200) version = response.body.data.version;
    }
    expect(patchStatuses).toEqual([200, 200, 200, 200, 200, 429]);

    await db.database.client.authRateBucket.deleteMany({
      where: { key: { startsWith: 'admin-content-publish:' } },
    });
    const reorderStatuses: number[] = [];
    for (let index = 0; index < 6; index++) {
      const response = await call('post', operator.cookie, '/inspirations/reorder', {
        reason,
        items: [
          {
            id: created.body.data.id,
            version,
            sortOrder: 100 + index,
          },
        ],
      });
      reorderStatuses.push(response.status);
      if (response.status === 201) version = response.body.data.items[0].version;
    }
    expect(reorderStatuses).toEqual([201, 201, 201, 201, 201, 429]);
  });

  it('returns safe input errors for every malformed mutation resource id', async () => {
    const body = inspiration(`bad-id-${randomUUID().slice(0, 8)}`, 'content-media-unused');
    const cases = [
      call('patch', operator.cookie, '/inspirations/not-a-uuid', { ...body, version: 1 }),
      call('post', operator.cookie, '/inspirations/not-a-uuid/transition', {
        version: 1,
        reason,
        status: 'offline',
      }),
      call('post', operator.cookie, '/inspirations/not-a-uuid/archive', { version: 1, reason }),
      call('post', operator.cookie, '/media/not-a-uuid/transition', {
        version: 1,
        reason,
        status: 'offline',
      }),
      call('post', operator.cookie, '/media/not-a-uuid/archive', { version: 1, reason }),
    ];
    for (const response of await Promise.all(cases)) {
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ code: 'ADMIN_INVALID_INPUT', data: null });
      expect(JSON.stringify(response.body)).not.toContain('Prisma');
    }
  });

  it('does not delete committed upload bytes after an ambiguous transaction result', async () => {
    const database = app.get(DatabaseService);
    const store = app.get<ObjectStore>(ASSET_STORE);
    const original = database.transaction.bind(database);
    const deleteSpy = vi.spyOn(store, 'delete');
    const transactionSpy = vi.spyOn(database, 'transaction');
    transactionSpy
      .mockImplementationOnce((work) => original(work))
      .mockImplementationOnce(async (work) => {
        await original(work);
        throw new Error('simulated commit acknowledgement loss');
      });
    try {
      const response = await upload(operator.cookie, randomUUID(), 'commit-ambiguous.png');
      expect(response.status).toBe(201);
      expect(deleteSpy).not.toHaveBeenCalled();
      expect(
        (await call('get', operator.cookie, `/media/${response.body.data.id}/content`)).status,
      ).toBe(200);
    } finally {
      transactionSpy.mockRestore();
      deleteSpy.mockRestore();
    }
  });

  it('does not accept an unrelated receipt and row as a committed upload', async () => {
    const database = app.get(DatabaseService);
    const store = app.get<ObjectStore>(ASSET_STORE);
    const originalTransaction = database.transaction.bind(database);
    const transactionSpy = vi.spyOn(database, 'transaction');
    transactionSpy
      .mockImplementationOnce((work) => originalTransaction(work))
      .mockImplementationOnce((work) =>
        originalTransaction(async (tx) => {
          await work(tx);
          throw new Error('simulated definite rollback');
        }),
      );
    let writtenKey = '';
    const originalPut = store.put.bind(store);
    const putSpy = vi
      .spyOn(store, 'put')
      .mockImplementationOnce(async (key, bytes, contentType) => {
        writtenKey = key;
        await originalPut(key, bytes, contentType);
      });
    const receiptSpy = vi.spyOn(database.client.adminCommandReceipt, 'findUnique');
    receiptSpy.mockResolvedValueOnce({
      action: 'team.role.create',
      target: 'custom_forged',
      requestDigest: '0'.repeat(64),
      result: { resourceId: 'forged-result' },
    } as never);
    const mediaSpy = vi.spyOn(database.client.contentMedia, 'findUnique');
    mediaSpy.mockResolvedValueOnce({ id: randomUUID(), objectKey: writtenKey } as never);
    try {
      const response = await upload(operator.cookie, randomUUID(), 'unrelated-receipt.png');
      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({ code: 'CONTENT_MEDIA_UPLOAD_OUTCOME_UNKNOWN' });
      expect(JSON.stringify(response.body)).not.toContain('forged-result');
    } finally {
      mediaSpy.mockRestore();
      receiptSpy.mockRestore();
      putSpy.mockRestore();
      transactionSpy.mockRestore();
    }
  });

  it('verifies and removes exact bytes when PutObject succeeds but its response is lost', async () => {
    const store = app.get<ObjectStore>(ASSET_STORE);
    const originalPut = store.put.bind(store);
    let writtenKey = '';
    const putSpy = vi
      .spyOn(store, 'put')
      .mockImplementationOnce(async (key, bytes, contentType) => {
        writtenKey = key;
        await originalPut(key, bytes, contentType);
        throw new Error('simulated PutObject acknowledgement loss');
      });
    const deleteSpy = vi.spyOn(store, 'delete');
    try {
      const response = await upload(operator.cookie, randomUUID(), 'put-ambiguous.png');
      expect(response.status).toBe(500);
      expect(deleteSpy).toHaveBeenCalledOnce();
      expect(deleteSpy).toHaveBeenCalledWith(writtenKey);
      await expect(store.get(writtenKey)).rejects.toBeDefined();
    } finally {
      deleteSpy.mockRestore();
      putSpy.mockRestore();
    }
  });

  it('deletes upload bytes only after a confirmed database rollback', async () => {
    const database = app.get(DatabaseService);
    const store = app.get<ObjectStore>(ASSET_STORE);
    const original = database.transaction.bind(database);
    const deleteSpy = vi.spyOn(store, 'delete');
    const transactionSpy = vi.spyOn(database, 'transaction');
    transactionSpy
      .mockImplementationOnce((work) => original(work))
      .mockImplementationOnce((work) =>
        original(async (tx) => {
          await work(tx);
          throw new Error('simulated definite rollback');
        }),
      );
    try {
      const response = await upload(operator.cookie, randomUUID(), 'rollback.png');
      expect(response.status).toBe(500);
      expect(deleteSpy).toHaveBeenCalledOnce();
    } finally {
      transactionSpy.mockRestore();
      deleteSpy.mockRestore();
    }
  });

  it('finishes rollback cleanup before allowing the same upload receipt to retry', async () => {
    const database = app.get(DatabaseService);
    const store = app.get<ObjectStore>(ASSET_STORE);
    const originalTransaction = database.transaction.bind(database);
    const transactionSpy = vi.spyOn(database, 'transaction');
    let transactionCall = 0;
    transactionSpy.mockImplementation((work) => {
      transactionCall++;
      return transactionCall === 2
        ? originalTransaction(async (tx) => {
            await work(tx);
            throw new Error('simulated first-attempt rollback');
          })
        : originalTransaction(work);
    });
    const originalDelete = store.delete.bind(store);
    let cleanupEntered!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => {
      cleanupEntered = resolve;
    });
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const deleteSpy = vi.spyOn(store, 'delete').mockImplementationOnce(async (objectKey) => {
      cleanupEntered();
      await cleanupGate;
      await originalDelete(objectKey);
    });
    const key = randomUUID();
    const first = upload(operator.cookie, key, 'serialized-retry.png').then((response) => response);
    let retry: Promise<Awaited<ReturnType<typeof upload>>> | undefined;
    try {
      await cleanupStarted;
      retry = upload(operator.cookie, key, 'serialized-retry.png').then((response) => response);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(
        await database.client.adminCommandReceipt.findUnique({
          where: {
            accountId_idempotencyKey: { accountId: operator.account.id, idempotencyKey: key },
          },
        }),
      ).toBeNull();
      releaseCleanup();
      expect((await first).status).toBe(500);
      const retried = await retry;
      expect(retried.status).toBe(201);
      expect(
        (await call('get', operator.cookie, `/media/${retried.body.data.id}/content`)).status,
      ).toBe(200);
    } finally {
      releaseCleanup();
      await Promise.allSettled([first, ...(retry ? [retry] : [])]);
      deleteSpy.mockRestore();
      transactionSpy.mockRestore();
    }
  });

  it('preserves uncertain upload bytes and records a reconciliation alert', async () => {
    const database = app.get(DatabaseService);
    const store = app.get<ObjectStore>(ASSET_STORE);
    const original = database.transaction.bind(database);
    const deleteSpy = vi.spyOn(store, 'delete');
    const transactionSpy = vi.spyOn(database, 'transaction');
    transactionSpy
      .mockImplementationOnce((work) => original(work))
      .mockImplementationOnce((work) =>
        original(async (tx) => {
          await work(tx);
          throw new Error('simulated rollback with unavailable confirmation');
        }),
      );
    const receiptSpy = vi
      .spyOn(database.client.adminCommandReceipt, 'findUnique')
      .mockRejectedValueOnce(new Error('confirmation unavailable'));
    try {
      const response = await upload(operator.cookie, randomUUID(), 'unknown.png');
      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({
        code: 'CONTENT_MEDIA_UPLOAD_OUTCOME_UNKNOWN',
        details: { reason: 'outcome_unknown' },
      });
      expect(deleteSpy).not.toHaveBeenCalled();
      expect(
        await database.client.adminAlert.count({ where: { kind: 'upload_outcome_unknown' } }),
      ).toBeGreaterThan(0);
    } finally {
      receiptSpy.mockRestore();
      transactionSpy.mockRestore();
      deleteSpy.mockRestore();
    }
  });

  it('classifies rollback cleanup failures and raises a safe operational alert', async () => {
    const database = app.get(DatabaseService);
    const store = app.get<ObjectStore>(ASSET_STORE);
    const original = database.transaction.bind(database);
    const transactionSpy = vi.spyOn(database, 'transaction');
    transactionSpy
      .mockImplementationOnce((work) => original(work))
      .mockImplementationOnce((work) =>
        original(async (tx) => {
          await work(tx);
          throw new Error('simulated definite rollback');
        }),
      );
    const deleteSpy = vi.spyOn(store, 'delete').mockRejectedValueOnce(new Error('delete failed'));
    try {
      const response = await upload(operator.cookie, randomUUID(), 'cleanup-failure.png');
      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({
        code: 'CONTENT_MEDIA_CLEANUP_PENDING',
        details: { reason: 'cleanup_pending' },
      });
      expect(
        await database.client.adminAlert.count({ where: { kind: 'rollback_cleanup_failed' } }),
      ).toBeGreaterThan(0);
      expect(JSON.stringify(response.body)).not.toContain('delete failed');
    } finally {
      deleteSpy.mockRestore();
      transactionSpy.mockRestore();
    }
  });

  it('exposes active content reconciliation alerts only to content-alert readers', async () => {
    const resourceId = randomUUID();
    const sourceKey = `content-media:upload_outcome_unknown:${resourceId}`;
    const alert = await db.database.client.adminAlert.create({
      data: {
        sourceKey,
        category: 'content',
        kind: 'upload_outcome_unknown',
        resourceId,
      },
    });
    try {
      const first = await request(app.getHttpServer())
        .get(`/api/admin/alerts?status=active&q=${alert.id}&source=upload_outcome_unknown`)
        .set('Cookie', operator.cookie);
      expect(first.status).toBe(200);
      expect(first.body.data.rows).toEqual([
        expect.objectContaining({
          category: 'content',
          kind: 'upload_outcome_unknown',
          resourceId,
          contentMediaId: resourceId,
          resolved: false,
        }),
      ]);
      const refreshed = await request(app.getHttpServer())
        .get(`/api/admin/alerts?status=active&q=${alert.id}&source=upload_outcome_unknown`)
        .set('Cookie', operator.cookie);
      expect(refreshed.body.data.rows).toHaveLength(1);
      const serviceOnly = await request(app.getHttpServer())
        .get(`/api/admin/alerts?status=active&q=${alert.id}&source=upload_outcome_unknown`)
        .set('Cookie', support.cookie);
      expect(serviceOnly.status).toBe(200);
      expect(serviceOnly.body.data.rows).toEqual([]);
    } finally {
      await db.database.client.adminAlert.deleteMany({ where: { sourceKey } });
    }
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

  it('uses the same ordered lock domain for seed publication and admin media offlining', async () => {
    await db.database.client.authRateBucket.deleteMany({
      where: { key: { startsWith: 'admin-content-publish:' } },
    });
    const sharedStore = app.get<ObjectStore>(ASSET_STORE);
    const media = (await upload()).body.data;
    const mediaExternalId = `seed-admin-media-${randomUUID().slice(0, 8)}`;
    await db.database.client.contentMedia.update({
      where: { id: media.id },
      data: { externalId: mediaExternalId },
    });
    await call('post', operator.cookie, `/media/${media.id}/transition`, {
      version: 1,
      reason,
      status: 'published',
    });
    const body = inspiration(`seed-admin-${randomUUID().slice(0, 8)}`, mediaExternalId);
    const created = await call('post', operator.cookie, '/inspirations', body);
    const manifest = structuredClone(contentSeedManifest);
    manifest.media = [{ ...manifest.media[0]!, externalId: mediaExternalId }];
    manifest.inspirations = [
      {
        ...manifest.inspirations[0]!,
        externalId: body.externalId,
        coverMediaExternalId: mediaExternalId,
        status: 'published',
      },
    ];
    manifest.templates = [];
    manifest.tools = [];

    const blocker = new pg.Client({ connectionString: db.url });
    await blocker.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `content:resource:media:${media.id}`,
    ]);
    const seeded = seedContent(db.database, sharedStore, { manifest });
    let offlined: Promise<Awaited<ReturnType<typeof call>>> | undefined;
    try {
      expect(await waitForExactAdvisoryWaiters(blocker, 1, 12_000)).toBe(true);
      const offlineRequest = call('post', operator.cookie, `/media/${media.id}/transition`, {
        version: 2,
        reason,
        status: 'offline',
      }).then((response) => response);
      offlined = offlineRequest;
      expect(await waitForExactAdvisoryWaiters(blocker, 2, 12_000)).toBe(true);
      await blocker.query('COMMIT');
      const [, offlineResponse] = await Promise.all([seeded, offlineRequest]);
      expect(offlineResponse.status).toBe(409);
      const finalContent = await db.database.client.inspiration.findUniqueOrThrow({
        where: { id: created.body.data.id },
      });
      const finalMedia = await db.database.client.contentMedia.findUniqueOrThrow({
        where: { id: media.id },
      });
      expect(finalContent.status).toBe('published');
      expect(finalMedia.status).toBe('published');
      const publicCatalog = await request(app.getHttpServer()).get(
        `/api/inspirations?category=${encodeURIComponent(manifest.inspirations[0]!.category)}`,
      );
      expect(publicCatalog.status).toBe(200);
      expect(publicCatalog.body.data.items).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: body.externalId })]),
      );
      const publicMedia = await request(app.getHttpServer()).get(
        `/api/content-media/${mediaExternalId}/content`,
      );
      expect(publicMedia.status).toBe(200);
      expect(
        createHash('sha256')
          .update(publicMedia.body as Buffer)
          .digest('hex'),
      ).toBe(finalMedia.sha256);
      expect(Buffer.from(publicMedia.body as Buffer)).toEqual(
        Buffer.from(await sharedStore.get(finalMedia.objectKey)),
      );
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      await blocker.end();
      await Promise.allSettled([seeded, ...(offlined ? [offlined] : [])]);
    }
  }, 30_000);

  it('reauthorizes inside a blocked command before performing work', async () => {
    const key = randomUUID();
    const blocker = new pg.Client({ connectionString: db.url });
    await blocker.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `admin:command-receipt:${operator.account.id}:${key}`,
    ]);
    const before = await db.database.client.contentMedia.count();
    const pending = upload(operator.cookie, key, 'reauthorize.png').then((response) => response);
    expect(await waitForExactAdvisoryWaiters(blocker, 1)).toBe(true);
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

function deterministicTestMediaId(accountId: string, idempotencyKey: string): string {
  const bytes = createHash('sha256')
    .update(`admin-content-media-v1:${accountId}:${idempotencyKey}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
