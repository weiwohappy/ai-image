import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';
import { createApp } from '../../src/main.js';
import { IdentityService } from '../../src/modules/identity/identity.service.js';

describe('immutable simulation quotes', () => {
  let db: TestDatabase;
  let app: INestApplication;
  let cookie: string;
  const input = {
    source: 'create',
    modelId: 'simulation-image-v1',
    prompt: 'A blue cup',
    resolution: '1K',
    ratio: '1:1',
    count: 4,
  };
  beforeAll(async () => {
    db = await createTestDatabase();
    app = await createApp({ databaseUrl: db.url, nodeEnv: 'test' });
    const user = await db.database.client.user.create({
      data: { email: 'quote@example.test', username: 'quote', passwordHash: 'unused' },
    });
    cookie = `viviai_session=${await app.get(IdentityService).createSession(user.id, user.authVersion)}`;
  });
  afterAll(async () => {
    await app?.close();
    await db?.cleanup();
  });
  const quote = (body: object) =>
    request(app.getHttpServer())
      .post('/api/generation-quotes')
      .set('Origin', 'http://localhost:3000')
      .set('Cookie', cookie)
      .send(body);
  it('returns an immutable five-minute quote with exact per-image cost', async () => {
    const response = await quote(input);
    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      unitCredits: 30,
      totalCredits: 120,
      input: { count: 4 },
      inputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(
      Date.parse(response.body.data.expiresAt) - Date.parse(response.body.data.createdAt),
    ).toBe(300_000);
  });
  it('rejects unsupported models, unknown parameters and invalid reference roles', async () => {
    for (const body of [
      { ...input, modelId: 'nano-banana' },
      { ...input, count: 5 },
      { ...input, providerId: 'cheap' },
      { ...input, source: 'remix' },
      { ...input, resolution: '4K' },
    ]) {
      expect((await quote(body)).status).toBe(400);
    }
  });
  it('catalog explicitly labels simulated images and no real model as available', async () => {
    const response = await request(app.getHttpServer()).get('/api/models');
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([
      expect.objectContaining({
        id: 'simulation-image-v1',
        name: '模拟图片（非 AI）',
        simulated: true,
      }),
    ]);
  });
});
