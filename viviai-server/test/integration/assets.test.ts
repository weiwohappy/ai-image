import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/main.js';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';
import { AssetService, ASSET_STORE } from '../../src/modules/assets/assets.service.js';
import type { ObjectStore } from '../../src/modules/assets/object-store.js';

const origin = 'http://127.0.0.1:3000';
// Generate a hand-sized raster fixture independently of the upload pipeline.
let png: Buffer;
describe('private persistent assets', () => {
  let db: TestDatabase;
  let app: Awaited<ReturnType<typeof createApp>>;
  let root: string;
  let alice: string;
  let bob: string;
  let assetId: string;
  async function register(username: string) {
    const email = `${username}@example.test`;
    await request(app.getHttpServer()).post('/api/auth/send-code').set('Origin', origin).send({ email, purpose: 'register' }).expect(201);
    const mails = await Promise.all((await readdir(join(root, 'mail'))).map(async name => JSON.parse(await readFile(join(root, 'mail', name), 'utf8'))));
    const response = await request(app.getHttpServer()).post('/api/auth/register').set('Origin', origin).send({ username, email, password: 'a long private password', code: mails.find(mail => mail.email === email).code }).expect(201);
    return response.headers['set-cookie'][0] as string;
  }
  beforeAll(async () => {
    png = await sharp({ create: { width: 16, height: 24, channels: 3, background: '#ee7722' } }).png().toBuffer();
    db = await createTestDatabase(); root = await mkdtemp(join(tmpdir(), 'viviai-assets-test-'));
    app = await createApp({ databaseUrl: db.url, localStorageRoot: join(root, 'objects'), devMailboxRoot: join(root, 'mail') });
    alice = await register('alice'); bob = await register('bob');
  });
  afterAll(async () => { await app?.close(); await db?.cleanup(); if (root) await rm(root, { recursive: true, force: true }); });
  function upload(bytes: Buffer, cookie?: string) {
    const call = request(app.getHttpServer()).post('/api/remix-references').set('Origin', origin);
    if (cookie) call.set('Cookie', cookie);
    return call.field('width', '9999').field('height', '9999').field('userId', 'spoofed').attach('file', bytes, 'private.png');
  }
  it('requires login before upload', async () => { expect((await upload(png)).body.code).toBe('AUTH_REQUIRED'); });
  it('decodes dimensions and exposes only an authenticated URL', async () => {
    const response = await upload(png, alice).expect(201);
    expect(response.body.data).toMatchObject({ name: 'private.png', width: 16, height: 24, status: 'ready' });
    expect(response.body.data.previewUrl).toMatch(/^\/api\/assets\/[^/]+\/content$/);
    expect(JSON.stringify(response.body)).not.toMatch(/objectKey|localStorageRoot/);
    assetId = response.body.data.id;
    const asset = await db.database.client.asset.findUniqueOrThrow({ where: { id: assetId } });
    expect((await app.get<ObjectStore>(ASSET_STORE).get(asset.objectKey)).length).toBeGreaterThan(0);
  });
  it('denies another owner every read and write', async () => {
    for (const suffix of ['', '/content']) await request(app.getHttpServer()).get(`/api/assets/${assetId}${suffix}`).set('Cookie', bob).expect(404);
    await request(app.getHttpServer()).patch(`/api/assets/${assetId}`).set('Origin', origin).set('Cookie', bob).send({ name: 'stolen' }).expect(404);
    await request(app.getHttpServer()).delete(`/api/assets/${assetId}`).set('Origin', origin).set('Cookie', bob).expect(404);
    const list = await request(app.getHttpServer()).get('/api/assets').set('Cookie', bob).expect(200);
    expect(list.body.data).toHaveLength(0);
    await request(app.getHttpServer()).get(`/api/assets/${assetId}/content`).expect(401);
  });
  it('rejects corrupted bytes and an upload larger than 5 MB', async () => {
    await upload(Buffer.from('not an image'), alice).expect(400);
    await upload(Buffer.alloc(5 * 1024 * 1024 + 1), alice).expect(413);
  });
  it('downloads persisted bytes after rebuilding the application', async () => {
    await app.close();
    app = await createApp({ databaseUrl: db.url, localStorageRoot: join(root, 'objects'), devMailboxRoot: join(root, 'mail') });
    const response = await request(app.getHttpServer()).get(`/api/assets/${assetId}/content`).set('Cookie', alice).expect(200);
    expect(response.headers['content-type']).toMatch(/^image\/png/);
    expect(response.headers['cache-control']).toContain('private');
    expect(response.body.length).toBeGreaterThan(20);
  });
  it('renames, favorites, soft deletes and restores only within seven days', async () => {
    const updated = await request(app.getHttpServer()).patch(`/api/assets/${assetId}`).set('Cookie', alice).set('Origin', origin).send({ name: 'renamed', favorite: true }).expect(200);
    expect(updated.body.data).toMatchObject({ name: 'renamed', favorite: true });
    await request(app.getHttpServer()).delete(`/api/assets/${assetId}`).set('Cookie', alice).set('Origin', origin).expect(200);
    await request(app.getHttpServer()).get(`/api/assets/${assetId}/content`).set('Cookie', alice).expect(404);
    await request(app.getHttpServer()).post(`/api/assets/${assetId}/restore`).set('Cookie', bob).set('Origin', origin).expect(404);
    await request(app.getHttpServer()).post(`/api/assets/${assetId}/restore`).set('Cookie', alice).set('Origin', origin).expect(201);
    await request(app.getHttpServer()).delete(`/api/assets/${assetId}`).set('Cookie', alice).set('Origin', origin).expect(200);
    await db.database.client.asset.update({ where: { id: assetId }, data: { deletedAt: new Date(Date.now() - 8 * 86400_000) } });
    await request(app.getHttpServer()).post(`/api/assets/${assetId}/restore`).set('Cookie', alice).set('Origin', origin).expect(404);
  });
  it('rejects animated WebP and decoded images larger than 40 megapixels', async () => {
    const frames = Buffer.concat([Buffer.alloc(16 * 24 * 3, 0), Buffer.alloc(16 * 24 * 3, 255)]);
    const animated = await sharp(frames, { raw: { width: 16, height: 48, channels: 3, pageHeight: 24 } }).webp({ delay: [100, 100] }).toBuffer();
    expect((await sharp(animated).metadata()).pages).toBe(2);
    await upload(animated, alice).expect(400);
    const huge = await sharp({ create: { width: 6400, height: 6400, channels: 3, background: '#eeeeee' } }).png().toBuffer();
    expect(huge.length).toBeLessThan(5 * 1024 * 1024);
    await upload(huge, alice).expect(400);
  });
  it('strips private metadata and applies EXIF orientation before reporting dimensions', async () => {
    const jpeg = await sharp(png).withMetadata({ orientation: 6, exif: { IFD0: { Artist: 'private-person' } } }).jpeg().toBuffer();
    const response = await upload(jpeg, alice).expect(201);
    expect(response.body.data).toMatchObject({ width: 24, height: 16 });
    const download = await request(app.getHttpServer()).get(response.body.data.previewUrl).set('Cookie', alice).expect(200);
    const metadata = await sharp(download.body).metadata();
    expect(metadata.exif).toBeUndefined();
    expect(download.body.includes(Buffer.from('private-person'))).toBe(false);
  });
  it('never creates ready metadata when object persistence fails', async () => {
    const user = await db.database.client.user.findUniqueOrThrow({ where: { username: 'alice' } });
    const before = await db.database.client.asset.count({ where: { userId: user.id } });
    const unavailable: ObjectStore = { async put() { throw new Error('storage offline'); }, async get() { throw new Error('unavailable'); }, async delete() {} };
    const service = new AssetService(db.database, unavailable);
    await expect(service.upload(user.id, png, 'failure.png')).rejects.toThrow('storage offline');
    expect(await db.database.client.asset.count({ where: { userId: user.id } })).toBe(before);
  });
});
