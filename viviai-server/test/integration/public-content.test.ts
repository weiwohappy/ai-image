import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/main.js';
import { ASSET_STORE } from '../../src/modules/assets/assets.service.js';
import type { ObjectStore } from '../../src/modules/assets/object-store.js';
import {
  IdentityService,
  SESSION_COOKIE,
  sessionTokenHash,
} from '../../src/modules/identity/identity.service.js';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';

const origin = 'http://127.0.0.1:3000';
const uuid = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;

describe('public operational content', () => {
  let database: TestDatabase;
  let app: Awaited<ReturnType<typeof createApp>>;
  let root: string;
  let aliceId: string;
  let bobId: string;
  let aliceCookie: string;
  let bobCookie: string;
  let expiredCookie: string;
  let publicBytes: Buffer;
  let publicMediaId: string;

  const get = (path: string, cookie?: string) => {
    const call = request(app.getHttpServer()).get(`/api${path}`);
    return cookie ? call.set('Cookie', cookie) : call;
  };
  const post = (path: string, cookie?: string) => {
    const call = request(app.getHttpServer()).post(`/api${path}`).set('Origin', origin);
    return cookie ? call.set('Cookie', cookie) : call;
  };
  const remove = (path: string, cookie?: string) => {
    const call = request(app.getHttpServer()).delete(`/api${path}`).set('Origin', origin);
    return cookie ? call.set('Cookie', cookie) : call;
  };

  async function createMedia(
    externalId: string,
    status: 'draft' | 'published' | 'offline' | 'archived',
    bytes: Uint8Array = Buffer.from(`content:${externalId}`),
  ) {
    const objectKey = `content/tests/${externalId}.png`;
    await app.get<ObjectStore>(ASSET_STORE).put(objectKey, bytes, 'image/png');
    return database.database.client.contentMedia.create({
      data: {
        externalId,
        objectKey,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        contentType: 'image/png',
        width: 16,
        height: 16,
        byteSize: bytes.length,
        status,
      },
    });
  }

  async function createInspiration(input: {
    id: string;
    externalId: string;
    category: string;
    sortOrder: number;
    status?: 'draft' | 'published' | 'offline';
    coverMediaId?: string;
    baseLikes?: number;
    title?: string;
    description?: string;
    tags?: string[];
  }) {
    return database.database.client.inspiration.create({
      data: {
        id: input.id,
        externalId: input.externalId,
        title: input.title ?? `Title ${input.externalId}`,
        description: input.description ?? 'private description',
        category: input.category,
        creatorName: 'Public creator',
        sourceType: 'platform',
        sourceName: 'Internal source name',
        sourceUrl: 'https://source.example/private-path',
        editorialLabel: 'Internal editorial label',
        baseLikes: input.baseLikes ?? 0,
        tags: input.tags ?? ['safe-tag'],
        defaultPrompt: `Prompt ${input.externalId}`,
        defaultModelId: 'gemini-3.1-flash-image',
        defaultOutputSpecId: 'png-1k-1x1-v1',
        coverMediaId: input.coverMediaId ?? publicMediaId,
        status: input.status ?? 'published',
        version: 3,
        sortOrder: input.sortOrder,
      },
    });
  }

  async function waitForAdvisoryWaiter(client: pg.Client): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const result = await client.query<{ waiting: number }>(
        `SELECT count(*)::int AS waiting
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> pg_backend_pid()
            AND wait_event_type = 'Lock'
            AND wait_event = 'advisory'`,
      );
      if ((result.rows[0]?.waiting ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Timed out waiting for the content interaction advisory lock');
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    root = await mkdtemp(join(tmpdir(), 'viviai-public-content-'));
    app = await createApp({
      nodeEnv: 'test',
      databaseUrl: database.url,
      localStorageRoot: join(root, 'objects'),
      devMailboxRoot: join(root, 'mail'),
    });
    const [alice, bob] = await Promise.all([
      database.database.client.user.create({
        data: { email: 'content-alice@example.test', username: 'content_alice', passwordHash: 'x' },
      }),
      database.database.client.user.create({
        data: { email: 'content-bob@example.test', username: 'content_bob', passwordHash: 'x' },
      }),
    ]);
    aliceId = alice.id;
    bobId = bob.id;
    const identity = app.get(IdentityService);
    aliceCookie = `${SESSION_COOKIE}=${await identity.createSession(alice.id, alice.authVersion)}`;
    bobCookie = `${SESSION_COOKIE}=${await identity.createSession(bob.id, bob.authVersion)}`;
    const expiredToken = 'e'.repeat(43);
    expiredCookie = `${SESSION_COOKIE}=${expiredToken}`;
    await database.database.client.session.create({
      data: {
        userId: alice.id,
        tokenHash: sessionTokenHash(expiredToken),
        authVersion: alice.authVersion,
        expiresAt: new Date(Date.now() - 1_000),
      },
    });

    publicBytes = Buffer.from('\x89PNG\r\n\x1a\npublic-content');
    const publicMedia = await createMedia('media-public', 'published', publicBytes);
    publicMediaId = publicMedia.id;
    const offlineMedia = await createMedia('media-offline', 'offline');
    const unreferencedMedia = await createMedia('media-unreferenced', 'published');
    const offlineReferenceMedia = await createMedia('media-offline-reference', 'published');
    const missingBytes = Buffer.from('missing-object');
    const missingObjectMedia = await database.database.client.contentMedia.create({
      data: {
        externalId: 'media-missing-object',
        objectKey: 'content/tests/media-missing-object.png',
        sha256: createHash('sha256').update(missingBytes).digest('hex'),
        contentType: 'image/png',
        width: 16,
        height: 16,
        byteSize: missingBytes.length,
        status: 'published',
      },
    });
    expect(unreferencedMedia.id).not.toBe(publicMedia.id);

    await Promise.all([
      createInspiration({
        id: uuid('10'),
        externalId: 'inspiration-main',
        category: 'featured',
        sortOrder: 2,
        baseLikes: 10,
      }),
      createInspiration({
        id: uuid('11'),
        externalId: 'inspiration-draft',
        category: 'featured',
        sortOrder: 0,
        status: 'draft',
      }),
      createInspiration({
        id: uuid('12'),
        externalId: 'inspiration-offline',
        category: 'featured',
        sortOrder: 1,
        status: 'offline',
      }),
      createInspiration({
        id: uuid('13'),
        externalId: 'inspiration-offline-media',
        category: 'other',
        sortOrder: 1,
        coverMediaId: offlineMedia.id,
      }),
      createInspiration({
        id: uuid('14'),
        externalId: 'inspiration-offline-reference',
        category: 'other',
        sortOrder: 2,
        status: 'offline',
        coverMediaId: offlineReferenceMedia.id,
      }),
      createInspiration({
        id: uuid('15'),
        externalId: 'inspiration-missing-object',
        category: 'other',
        sortOrder: 3,
        coverMediaId: missingObjectMedia.id,
      }),
    ]);

    await database.database.client.remixTemplate.create({
      data: {
        id: uuid('20'),
        externalId: 'template-main',
        title: 'Template main',
        description: 'private template description',
        category: 'commerce',
        platform: 'xiaohongshu',
        industry: 'beauty',
        style: 'cinematic',
        creatorName: 'Template creator',
        sourceType: 'platform',
        sourceName: 'Private source',
        sourceUrl: 'https://source.example/template',
        popularityLabel: 'Trending',
        baseRemixCount: 42,
        tags: ['featured', 'contrast'],
        visualAnalysis: {
          composition: 'centered',
          palette: ['#112233'],
          lighting: 'soft',
          camera: 'eye-level',
          typographyZone: 'right',
          avoid: ['logo'],
        },
        defaultPrompt: 'private default prompt',
        defaultParameters: { strength: 'balanced' },
        defaultModelId: 'gemini-3.1-flash-image',
        defaultOutputSpecId: 'png-1k-3x4-v1',
        coverMediaId: publicMedia.id,
        referenceMediaId: publicMedia.id,
        status: 'published',
        version: 4,
        sortOrder: 0,
      },
    });
    await database.database.client.remixTemplate.create({
      data: {
        id: uuid('21'),
        externalId: 'template-offline',
        title: 'Template offline',
        description: 'hidden',
        category: 'commerce',
        platform: 'xiaohongshu',
        industry: 'beauty',
        style: 'cinematic',
        sourceType: 'platform',
        baseRemixCount: 0,
        tags: [],
        visualAnalysis: {
          composition: 'hidden',
          palette: ['#000000'],
          lighting: 'hidden',
          camera: 'hidden',
          typographyZone: 'hidden',
          avoid: [],
        },
        defaultPrompt: 'hidden',
        defaultParameters: {},
        defaultModelId: 'gemini-3.1-flash-image',
        defaultOutputSpecId: 'png-1k-1x1-v1',
        coverMediaId: publicMedia.id,
        status: 'offline',
        version: 1,
        sortOrder: 1,
      },
    });
    await database.database.client.toolDefinition.create({
      data: {
        id: uuid('30'),
        externalId: 'tool-main',
        name: 'Tool main',
        description: 'Tool description',
        category: 'commerce',
        creatorName: 'Private creator',
        sourceType: 'platform',
        sourceName: 'Private source',
        sourceUrl: 'https://source.example/tool',
        isNew: true,
        fieldSchema: [
          {
            id: 'style',
            label: 'Style',
            type: 'select',
            required: true,
            options: [{ label: 'Clean', value: 'clean' }],
          },
        ],
        promptTemplate: 'private {{style}} prompt',
        defaults: {
          modelId: 'gemini-3.1-flash-image',
          resolution: '1K',
          ratio: '1:1',
          count: 1,
        },
        maxAssets: 2,
        maxOutputCount: 1,
        assetLabel: 'Product image',
        defaultModelId: 'gemini-3.1-flash-image',
        defaultOutputSpecId: 'png-1k-1x1-v1',
        coverMediaId: publicMedia.id,
        status: 'published',
        version: 2,
        sortOrder: 0,
      },
    });
  });

  afterAll(async () => {
    await app?.close();
    await database?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('returns strict published inspiration DTOs to signed-out and invalid sessions', async () => {
    for (const cookie of [undefined, `${SESSION_COOKIE}=${'x'.repeat(43)}`, expiredCookie]) {
      const response = await get('/inspirations?category=featured', cookie).expect(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.headers.vary?.split(/\s*,\s*/)).toContain('Cookie');
      expect(response.body.data).toEqual({
        items: [
          {
            id: 'inspiration-main',
            title: 'Title inspiration-main',
            imageUrl: '/api/content-media/media-public/content',
            prompt: 'Prompt inspiration-main',
            category: 'featured',
            creator: 'Public creator',
            likes: 10,
            liked: false,
          },
        ],
        nextCursor: null,
      });
      expect(JSON.stringify(response.body.data)).not.toMatch(
        /objectKey|sourceUrl|sourceName|description|editorialLabel|defaultModelId|00000000-/,
      );
    }
    await get('/inspirations?unknown=value').expect(400);
    await get('/inspirations?cursor=').expect(400);
    await get('/inspirations?limit=0').expect(400);
    await get('/inspirations?limit=51').expect(400);
  });

  it('paginates stable ties with opaque filter-bound cursors after the anchor goes offline', async () => {
    for (let index = 0; index < 4; index++)
      await createInspiration({
        id: uuid(String(100 + index)),
        externalId: `inspiration-page-${index + 1}`,
        category: 'paging',
        sortOrder: index < 3 ? 10 : 11,
      });

    const first = await get('/inspirations?category=paging&limit=2').expect(200);
    expect(first.body.data.items.map((item: { id: string }) => item.id)).toEqual([
      'inspiration-page-1',
      'inspiration-page-2',
    ]);
    const cursor = first.body.data.nextCursor as string;
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cursor).not.toContain('00000000');

    await database.database.client.inspiration.update({
      where: { externalId: 'inspiration-page-2' },
      data: { status: 'offline' },
    });
    const second = await get(
      `/inspirations?category=paging&limit=2&cursor=${encodeURIComponent(cursor)}`,
    ).expect(200);
    expect(second.body.data.items.map((item: { id: string }) => item.id)).toEqual([
      'inspiration-page-3',
      'inspiration-page-4',
    ]);
    expect(second.body.data.nextCursor).toBeNull();

    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('A') ? 'B' : 'A'}`;
    await get(
      `/inspirations?category=paging&limit=2&cursor=${encodeURIComponent(tampered)}`,
    ).expect(400);
    await get(
      `/inspirations?category=featured&limit=2&cursor=${encodeURIComponent(cursor)}`,
    ).expect(400);

    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const forgeWithPlainSha = (changes: Record<string, unknown>) => {
      const payload = { ...decoded, ...changes };
      delete payload.checksum;
      return Buffer.from(
        JSON.stringify({
          ...payload,
          checksum: createHash('sha256')
            .update(`content-cursor-v1:${JSON.stringify(payload)}`)
            .digest('hex'),
        }),
      ).toString('base64url');
    };
    const forgedErrors = [];
    for (const changes of [
      { externalId: 'inspiration-page-3' },
      { externalId: 'inspiration-anchor-does-not-exist' },
      { sortOrder: 11 },
      { filter: '{"category":"featured"}' },
      { kind: 'tools' },
    ]) {
      const forged = forgeWithPlainSha(changes);
      const forgedResponse = await get(
        `/inspirations?category=paging&limit=2&cursor=${encodeURIComponent(forged)}`,
      ).expect(400);
      const publicError = {
        data: forgedResponse.body.data,
        code: forgedResponse.body.code,
        message: forgedResponse.body.message,
      };
      expect(publicError).toEqual({
        data: null,
        code: 'INVALID_CURSOR',
        message: 'Pagination cursor is invalid',
      });
      forgedErrors.push(publicError);
    }
    expect(new Set(forgedErrors.map((error) => JSON.stringify(error))).size).toBe(1);
  });

  it('searches catalog title, description and exact tags without breaking the keyset cursor', async () => {
    const rows = [
      {
        id: uuid('40'),
        externalId: 'inspiration-search-a',
        title: 'Amber bottle study',
        description: 'warm gradient backdrop',
        tags: ['glass'],
        sortOrder: 0,
      },
      {
        id: uuid('41'),
        externalId: 'inspiration-search-c',
        title: 'Copper tray study',
        description: 'matte metal finish',
        tags: ['metal'],
        sortOrder: 1,
      },
      {
        id: uuid('42'),
        externalId: 'inspiration-search-b',
        title: 'Silver bottle study',
        description: 'cool gradient backdrop',
        tags: ['glass'],
        sortOrder: 2,
      },
      {
        id: uuid('43'),
        externalId: 'inspiration-search-d',
        title: 'Neutral object',
        description: 'brushed aluminium finish',
        tags: ['stone'],
        sortOrder: 3,
      },
    ];
    for (const row of rows) await createInspiration({ ...row, category: 'searchable' });

    const ids = (response: { body: { data: { items: Array<{ id: string }> } } }) =>
      response.body.data.items.map((item) => item.id);
    const search = (query: string) =>
      get(`/inspirations?category=searchable&query=${encodeURIComponent(query)}`).expect(200);

    expect(ids(await get('/inspirations?category=searchable').expect(200))).toEqual(
      rows.map((row) => row.externalId),
    );
    // Title text is matched case-insensitively, descriptions are searchable, tags compare exactly.
    expect(ids(await search('AMBER'))).toEqual(['inspiration-search-a']);
    expect(ids(await search('aluminium'))).toEqual(['inspiration-search-d']);
    expect(ids(await search('metal'))).toEqual(['inspiration-search-c']);
    // A tag prefix must not leak the rest of its category, and nothing matches an absent term.
    expect(ids(await search('glas'))).toEqual([]);
    expect(ids(await search('porcelain'))).toEqual([]);

    // The keyset cursor and the search clause are ANDed: the page after the first match must
    // skip inspiration-search-c, which sits between the two 'bottle' rows but does not match.
    const firstPage = await get(
      '/inspirations?category=searchable&query=bottle&limit=1',
    ).expect(200);
    expect(ids(firstPage)).toEqual(['inspiration-search-a']);
    const cursor = firstPage.body.data.nextCursor as string;
    expect(cursor).toBeTruthy();
    const secondPage = await get(
      `/inspirations?category=searchable&query=bottle&limit=1&cursor=${encodeURIComponent(cursor)}`,
    ).expect(200);
    expect(ids(secondPage)).toEqual(['inspiration-search-b']);
    expect(secondPage.body.data.nextCursor).toBeNull();

    // A cursor is bound to the term that minted it, so replayed results stay consistent.
    await get(
      `/inspirations?category=searchable&limit=1&cursor=${encodeURIComponent(cursor)}`,
    ).expect(400);
    await get(
      `/inspirations?category=searchable&query=bottles&limit=1&cursor=${encodeURIComponent(cursor)}`,
    ).expect(400);
    await get('/inspirations?category=searchable&query=').expect(400);
    await get(`/inspirations?category=searchable&query=${'x'.repeat(161)}`).expect(400);

    const templates = await get('/remix-templates?query=contrast').expect(200);
    expect(templates.body.data.items.map((item: { id: string }) => item.id)).toEqual([
      'template-main',
    ]);
    // Offline copy stays invisible even when the search term only appears inside it.
    const offlineOnly = await get('/remix-templates?query=hidden').expect(200);
    expect(offlineOnly.body.data.items).toEqual([]);
  });

  it('maps template and tool JSON into exact frontend contracts and hides offline detail', async () => {
    const templates = await get(
      '/remix-templates?category=commerce&platform=xiaohongshu&industry=beauty&style=cinematic',
    ).expect(200);
    expect(templates.headers['cache-control']).toBe('private, no-store');
    expect(templates.headers.vary?.split(/\s*,\s*/)).toContain('Cookie');
    expect(templates.body.data).toEqual({
      items: [
        {
          id: 'template-main',
          version: 4,
          title: 'Template main',
          coverUrl: '/api/content-media/media-public/content',
          category: 'commerce',
          platform: 'xiaohongshu',
          industry: 'beauty',
          style: 'cinematic',
          tags: ['featured', 'contrast'],
          recommendedModelId: 'gemini-3.1-flash-image',
          recommendedRatio: '3:4',
          sourceType: 'platform',
          popularityLabel: 'Trending',
          remixCount: 42,
          favorite: false,
          status: 'active',
          analysis: {
            composition: 'centered',
            palette: ['#112233'],
            lighting: 'soft',
            camera: 'eye-level',
            typographyZone: 'right',
            avoid: ['logo'],
          },
        },
      ],
      nextCursor: null,
    });
    const templateDetail = await get('/remix-templates/template-main').expect(200);
    expect(templateDetail.headers['cache-control']).toBe('private, no-store');
    expect(templateDetail.headers.vary?.split(/\s*,\s*/)).toContain('Cookie');
    expect(templateDetail.body.data).toEqual(templates.body.data.items[0]);
    await get('/remix-templates/template-offline').expect(404);
    await get('/remix-templates/does-not-exist').expect(404);
    await get('/remix-templates?unknown=value').expect(400);

    const tools = await get('/tools?category=commerce').expect(200);
    expect(tools.body.data).toEqual({
      items: [
        {
          id: 'tool-main',
          name: 'Tool main',
          description: 'Tool description',
          category: 'commerce',
          version: 2,
          isNew: true,
          coverUrl: '/api/content-media/media-public/content',
          maxAssets: 2,
          assetLabel: 'Product image',
          fields: [
            {
              id: 'style',
              label: 'Style',
              type: 'select',
              required: true,
              options: [{ label: 'Clean', value: 'clean' }],
            },
          ],
          defaults: {
            modelId: 'gemini-3.1-flash-image',
            resolution: '1K',
            ratio: '1:1',
            count: 1,
          },
        },
      ],
      nextCursor: null,
    });
    expect((await get('/tools/tool-main').expect(200)).body.data).toEqual(tools.body.data.items[0]);
    await get('/tools/does-not-exist').expect(404);
    await get('/tools?unknown=value').expect(400);
  });

  it('attaches per-user interaction state without leaking it across users', async () => {
    await database.database.client.inspirationLike.create({
      data: {
        userId: aliceId,
        inspirationId: (
          await database.database.client.inspiration.findUniqueOrThrow({
            where: { externalId: 'inspiration-main' },
          })
        ).id,
      },
    });
    await database.database.client.remixTemplateFavorite.create({
      data: {
        userId: aliceId,
        remixTemplateId: (
          await database.database.client.remixTemplate.findUniqueOrThrow({
            where: { externalId: 'template-main' },
          })
        ).id,
      },
    });
    const aliceInspiration = await get('/inspirations?category=featured', aliceCookie).expect(200);
    const bobInspiration = await get('/inspirations?category=featured', bobCookie).expect(200);
    expect(aliceInspiration.headers['cache-control']).toBe('private, no-store');
    expect(aliceInspiration.headers.vary?.split(/\s*,\s*/)).toContain('Cookie');
    expect(bobInspiration.headers['cache-control']).toBe('private, no-store');
    expect(aliceInspiration.body.data.items[0]).toMatchObject({ likes: 11, liked: true });
    expect(bobInspiration.body.data.items[0]).toMatchObject({ likes: 11, liked: false });
    expect(
      (await get('/remix-templates/template-main', aliceCookie).expect(200)).body.data.favorite,
    ).toBe(true);
    expect(
      (await get('/remix-templates/template-main', bobCookie).expect(200)).body.data.favorite,
    ).toBe(false);
  });

  it('makes like commands authenticated, published-only, idempotent, and authoritative', async () => {
    const target = await database.database.client.inspiration.findUniqueOrThrow({
      where: { externalId: 'inspiration-main' },
    });
    await database.database.client.inspirationLike.deleteMany({
      where: { inspirationId: target.id },
    });
    await post('/inspirations/inspiration-main/like').expect(401);
    await post('/inspirations/inspiration-main/like', `${SESSION_COOKIE}=${'x'.repeat(43)}`).expect(
      401,
    );

    const first = await post('/inspirations/inspiration-main/like', aliceCookie).expect(201);
    const repeated = await post('/inspirations/inspiration-main/like', aliceCookie).expect(201);
    expect(first.body.data).toMatchObject({ id: 'inspiration-main', likes: 11, liked: true });
    expect(repeated.body.data).toEqual(first.body.data);
    expect(
      await database.database.client.inspirationLike.count({
        where: { userId: aliceId, inspirationId: target.id },
      }),
    ).toBe(1);
    const bobView = await get('/inspirations?category=featured', bobCookie).expect(200);
    expect(bobView.body.data.items[0]).toMatchObject({ likes: 11, liked: false });

    await post('/inspirations/inspiration-main/like', bobCookie).expect(201);
    const removed = await remove('/inspirations/inspiration-main/like', aliceCookie).expect(200);
    const removedAgain = await remove('/inspirations/inspiration-main/like', aliceCookie).expect(
      200,
    );
    expect(removed.body.data).toMatchObject({ likes: 11, liked: false });
    expect(removedAgain.body.data).toEqual(removed.body.data);
    expect(
      await database.database.client.inspirationLike.count({ where: { inspirationId: target.id } }),
    ).toBe(1);
    await post('/inspirations/inspiration-offline/like', aliceCookie).expect(404);
    await remove('/inspirations/does-not-exist/like', aliceCookie).expect(404);
  });

  it('makes favorite commands idempotent and isolated by user', async () => {
    const target = await database.database.client.remixTemplate.findUniqueOrThrow({
      where: { externalId: 'template-main' },
    });
    await database.database.client.remixTemplateFavorite.deleteMany({
      where: { remixTemplateId: target.id },
    });
    await post('/remix-templates/template-main/favorite').expect(401);
    const first = await post('/remix-templates/template-main/favorite', aliceCookie).expect(201);
    const repeated = await post('/remix-templates/template-main/favorite', aliceCookie).expect(201);
    expect(first.body.data).toMatchObject({ id: 'template-main', favorite: true });
    expect(repeated.body.data).toEqual(first.body.data);
    expect(
      await database.database.client.remixTemplateFavorite.count({
        where: { userId: aliceId, remixTemplateId: target.id },
      }),
    ).toBe(1);
    expect(
      (await get('/remix-templates/template-main', bobCookie).expect(200)).body.data.favorite,
    ).toBe(false);
    const removed = await remove('/remix-templates/template-main/favorite', aliceCookie).expect(
      200,
    );
    const removedAgain = await remove(
      '/remix-templates/template-main/favorite',
      aliceCookie,
    ).expect(200);
    expect(removed.body.data.favorite).toBe(false);
    expect(removedAgain.body.data).toEqual(removed.body.data);
    await post('/remix-templates/template-offline/favorite', aliceCookie).expect(404);
  });

  it('serializes concurrent inspiration mutations before returning authoritative counts', async () => {
    const target = await database.database.client.inspiration.findUniqueOrThrow({
      where: { externalId: 'inspiration-main' },
    });
    await database.database.client.inspirationLike.deleteMany({
      where: { inspirationId: target.id },
    });

    const lockClient = new pg.Client({ connectionString: database.url });
    await lockClient.connect();
    await lockClient.query('BEGIN');
    await lockClient.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `content:inspiration-interaction:${target.id}`,
    ]);
    const pending = [
      post('/inspirations/inspiration-main/like', aliceCookie)
        .expect(201)
        .then((response) => response),
      post('/inspirations/inspiration-main/like', bobCookie)
        .expect(201)
        .then((response) => response),
    ];
    let waitError: unknown;
    try {
      await waitForAdvisoryWaiter(lockClient);
    } catch (error) {
      waitError = error;
    } finally {
      await lockClient.query('ROLLBACK').catch(() => undefined);
      await lockClient.end().catch(() => undefined);
    }
    const responses = await Promise.all(pending);
    if (waitError) throw waitError;

    expect(responses.map((response) => response.body.data.likes).sort()).toEqual([11, 12]);
    expect(
      await database.database.client.inspirationLike.count({
        where: { inspirationId: target.id },
      }),
    ).toBe(2);
    const replay = await post('/inspirations/inspiration-main/like', aliceCookie).expect(201);
    expect(replay.body.data).toMatchObject({ likes: 12, liked: true });
  });

  it('streams only published reachable media with revalidating validators', async () => {
    const response = await get('/content-media/media-public/content').expect(200);
    expect(Buffer.compare(response.body, publicBytes)).toBe(0);
    expect(response.headers['content-type']).toMatch(/^image\/png/);
    expect(response.headers['content-length']).toBe(String(publicBytes.length));
    expect(response.headers.etag).toBe(
      `"${createHash('sha256').update(publicBytes).digest('hex')}"`,
    );
    expect(response.headers['cache-control']).toBe('public, max-age=0, must-revalidate');
    expect(response.headers['x-content-type-options']).toBe('nosniff');

    await request(app.getHttpServer())
      .get('/api/content-media/media-public/content')
      .set('If-None-Match', response.headers.etag!)
      .expect(304)
      .expect((notModified) => expect(notModified.body).toHaveLength(0));

    const replacement = Buffer.from('\x89PNG\r\n\x1a\npublic-content-v2');
    const media = await database.database.client.contentMedia.findUniqueOrThrow({
      where: { externalId: 'media-public' },
    });
    await app.get<ObjectStore>(ASSET_STORE).put(media.objectKey, replacement, 'image/png');
    await database.database.client.contentMedia.update({
      where: { id: media.id },
      data: {
        sha256: createHash('sha256').update(replacement).digest('hex'),
        byteSize: replacement.length,
      },
    });
    const refreshed = await request(app.getHttpServer())
      .get('/api/content-media/media-public/content')
      .set('If-None-Match', response.headers.etag!)
      .expect(200);
    expect(Buffer.compare(refreshed.body, replacement)).toBe(0);
    expect(refreshed.headers.etag).toBe(
      `"${createHash('sha256').update(replacement).digest('hex')}"`,
    );
    expect(refreshed.headers.etag).not.toBe(response.headers.etag);
    await get('/content-media/media-unreferenced/content').expect(404);
    await get('/content-media/media-offline/content').expect(404);
    await get('/content-media/media-offline-reference/content').expect(404);
    await get('/content-media/media-missing-object/content').expect(404);
    await get(`/content-media/${publicMediaId}/content`).expect(404);

    await Promise.all([
      database.database.client.inspiration.updateMany({
        where: { OR: [{ coverMediaId: media.id }, { caseMediaId: media.id }] },
        data: { status: 'offline' },
      }),
      database.database.client.remixTemplate.updateMany({
        where: { OR: [{ coverMediaId: media.id }, { referenceMediaId: media.id }] },
        data: { status: 'offline' },
      }),
      database.database.client.toolDefinition.updateMany({
        where: { OR: [{ coverMediaId: media.id }, { iconMediaId: media.id }] },
        data: { status: 'offline' },
      }),
    ]);
    await request(app.getHttpServer())
      .get('/api/content-media/media-public/content')
      .set('If-None-Match', refreshed.headers.etag!)
      .expect(404);
  });

  it('fails safely when published structured content is corrupt', async () => {
    const corrupt = await database.database.client.toolDefinition.create({
      data: {
        externalId: 'tool-corrupt',
        name: 'Corrupt',
        description: 'Corrupt',
        category: 'corrupt',
        fieldSchema: { unexpected: 'not an array' },
        promptTemplate: 'private prompt',
        defaults: { modelId: 'leaked-private-value' },
        maxAssets: 0,
        maxOutputCount: 1,
        assetLabel: 'Image',
        defaultModelId: 'gemini-3.1-flash-image',
        defaultOutputSpecId: 'png-1k-1x1-v1',
        coverMediaId: publicMediaId,
        status: 'published',
        sortOrder: 0,
      },
    });
    try {
      const response = await get('/tools?category=corrupt').expect(500);
      expect(response.body).toMatchObject({ data: null, code: 'CONTENT_DATA_INVALID' });
      expect(JSON.stringify(response.body)).not.toContain('leaked-private-value');
    } finally {
      await database.database.client.toolDefinition.update({
        where: { id: corrupt.id },
        data: { status: 'offline' },
      });
    }
  });

  it('rejects duplicate stored tool field IDs instead of projecting an ambiguous form', async () => {
    const duplicate = await database.database.client.toolDefinition.create({
      data: {
        externalId: 'tool-duplicate-fields',
        name: 'Duplicate fields',
        description: 'Duplicate fields',
        category: 'corrupt-duplicate',
        fieldSchema: [
          { id: 'style', label: 'First', type: 'text', required: true },
          { id: 'style', label: 'Second', type: 'text', required: false },
        ],
        promptTemplate: 'private {{style}} prompt',
        defaults: {
          modelId: 'gemini-3.1-flash-image',
          resolution: '1K',
          ratio: '1:1',
          count: 1,
        },
        maxAssets: 0,
        maxOutputCount: 1,
        assetLabel: 'Image',
        defaultModelId: 'gemini-3.1-flash-image',
        defaultOutputSpecId: 'png-1k-1x1-v1',
        coverMediaId: publicMediaId,
        status: 'published',
        sortOrder: 0,
      },
    });
    try {
      const response = await get('/tools?category=corrupt-duplicate').expect(500);
      expect(response.body).toMatchObject({ data: null, code: 'CONTENT_DATA_INVALID' });
      expect(JSON.stringify(response.body)).not.toContain('Second');
    } finally {
      await database.database.client.toolDefinition.update({
        where: { id: duplicate.id },
        data: { status: 'offline' },
      });
    }
  });
});
