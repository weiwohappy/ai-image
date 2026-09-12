import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import sharp from 'sharp';
import { createApp } from '../../src/main.js';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';
import { responseCookie } from '../helpers/http.js';

const origin = 'http://127.0.0.1:3000';
const password = 'correct horse battery staple';

describe('authenticated account avatar upload', () => {
  let database: TestDatabase;
  let app: Awaited<ReturnType<typeof createApp>>;
  let root: string;
  let alice: string;
  let bob: string;
  let png: Buffer;

  async function register(username: string) {
    const email = `${username}@example.test`;
    await request(app.getHttpServer())
      .post('/api/auth/send-code')
      .set('Origin', origin)
      .send({ email, purpose: 'register' })
      .expect(201);
    const messages = await Promise.all(
      (await readdir(join(root, 'mail'))).map(async (name) =>
        JSON.parse(await readFile(join(root, 'mail', name), 'utf8')),
      ),
    );
    const response = await request(app.getHttpServer())
      .post('/api/auth/register')
      .set('Origin', origin)
      .send({
        username,
        email,
        password,
        code: messages.find((message) => message.email === email).code,
      })
      .expect(201);
    return responseCookie(response);
  }

  function upload(cookie: string, bytes: Buffer, name = 'avatar.png') {
    return request(app.getHttpServer())
      .post('/api/account/avatar')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .attach('file', bytes, name);
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    root = await mkdtemp(join(tmpdir(), 'viviai-avatar-test-'));
    app = await createApp({
      databaseUrl: database.url,
      localStorageRoot: join(root, 'objects'),
      devMailboxRoot: join(root, 'mail'),
    });
    png = await sharp({ create: { width: 16, height: 24, channels: 3, background: '#ee7722' } })
      .png()
      .toBuffer();
    alice = await register('avatar_alice');
    bob = await register('avatar_bob');
  });

  afterAll(async () => {
    await app?.close();
    await database?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('stores a validated private avatar for the authenticated user', async () => {
    const response = await upload(alice, png).expect(201);

    expect(response.body.data.avatarUrl).toMatch(/^\/api\/assets\/[0-9a-f-]+\/content$/);
    expect(JSON.stringify(response.body)).not.toMatch(/objectKey|localStorageRoot/);
    const user = await database.database.client.user.findUniqueOrThrow({
      where: { username: 'avatar_alice' },
    });
    expect(response.body.data.avatarUrl).toBe(`/api/assets/${user.avatarAssetId}/content`);
    const asset = await database.database.client.asset.findUniqueOrThrow({
      where: { id: user.avatarAssetId! },
    });
    expect(asset).toMatchObject({ userId: user.id, source: 'upload', width: 16, height: 24 });
  });

  it('rejects invalid image content and files larger than one MiB', async () => {
    const invalid = await upload(alice, Buffer.from('not an image')).expect(400);
    expect(invalid.body.code).toBe('ASSET_INVALID');
    await upload(alice, Buffer.alloc(1024 * 1024 + 1)).expect(413);
  });

  it('does not accept an avatar URL in place of an uploaded image', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/account/avatar')
      .set('Origin', origin)
      .set('Cookie', alice)
      .send({ avatarUrl: '/api/assets/not-an-avatar/content' })
      .expect(400);

    expect(response.body.code).toBe('ASSET_INVALID');
  });

  it('replaces only the caller avatar without reassigning another user asset', async () => {
    const bobAvatar = await upload(bob, png).expect(201);
    const bobUrl = bobAvatar.body.data.avatarUrl;
    const aliceAvatar = await upload(
      alice,
      await sharp({ create: { width: 20, height: 12, channels: 3, background: '#2277ee' } })
        .png()
        .toBuffer(),
    ).expect(201);

    expect(aliceAvatar.body.data.avatarUrl).not.toBe(bobUrl);
    const bobUser = await database.database.client.user.findUniqueOrThrow({
      where: { username: 'avatar_bob' },
    });
    const bobAsset = await database.database.client.asset.findUniqueOrThrow({
      where: { id: bobUser.avatarAssetId! },
    });
    expect(bobUrl).toBe(`/api/assets/${bobAsset.id}/content`);
    expect(bobAsset.userId).toBe(bobUser.id);
  });
});
