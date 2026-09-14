import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';
import { createApp } from '../../src/main.js';
import { IdentityService } from '../../src/modules/identity/identity.service.js';

const origin = 'http://localhost:3000';

const definition = (name: string) => ({
  name,
  columns: [{ id: 'ref', name: 'Reference', type: 'reference' }],
  rows: [{ rowKey: 'row-1', cells: {} }],
});

describe('workflow optimistic concurrency', () => {
  let db: TestDatabase;
  let app: INestApplication;

  beforeAll(async () => {
    db = await createTestDatabase();
    app = await createApp({ nodeEnv: 'test', databaseUrl: db.url });
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app?.close();
    await db?.cleanup();
  });

  it('lets exactly one of two same-version updates win', async () => {
    const id = randomUUID();
    await db.database.client.user.create({
      data: { id, email: `${id}@example.test`, username: id, passwordHash: 'unused' },
    });
    const cookie = `viviai_session=${await app.get(IdentityService).createSession(id, 1)}`;
    const created = await request(app.getHttpServer())
      .post('/api/workflows')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send(definition('Race'))
      .expect(201);
    const workflowId = created.body.data.id;

    const update = (body: object) =>
      request(app.getHttpServer())
        .put(`/api/workflows/${workflowId}`)
        .set('Origin', origin)
        .set('Cookie', cookie)
        .send(body);

    const [first, second] = await Promise.all([
      update({ version: 1, ...definition('Race A') }),
      update({ version: 1, ...definition('Race B') }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
  });
});
