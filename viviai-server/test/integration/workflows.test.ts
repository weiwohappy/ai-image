import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';
import { createApp } from '../../src/main.js';
import { IdentityService } from '../../src/modules/identity/identity.service.js';

const origin = 'http://localhost:3000';

const validWorkflow = () => ({
  name: 'Campaign A',
  columns: [
    { id: 'ref', name: 'Reference', type: 'reference' },
    {
      id: 'gen',
      name: 'Generation',
      type: 'generation',
      prompt: 'A clean product photo',
      sourceColumnIds: ['ref'],
      modelId: 'simulation-image-v1',
      resolution: '1K',
      ratio: '1:1',
    },
  ],
  rows: [{ rowKey: 'row-1', cells: { ref: randomUUID() } }],
});

describe('workflow CRUD', () => {
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

  async function actor() {
    const id = randomUUID();
    await db.database.client.user.create({
      data: { id, email: `${id}@example.test`, username: id, passwordHash: 'unused' },
    });
    return { id, cookie: `viviai_session=${await app.get(IdentityService).createSession(id, 1)}` };
  }

  const get = (cookie: string, path: string) =>
    request(app.getHttpServer()).get(`/api${path}`).set('Origin', origin).set('Cookie', cookie);
  const post = (cookie: string, path: string, body?: object) =>
    request(app.getHttpServer())
      .post(`/api${path}`)
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send(body ?? {});
  const put = (cookie: string, path: string, body: object) =>
    request(app.getHttpServer())
      .put(`/api${path}`)
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send(body);
  const del = (cookie: string, path: string) =>
    request(app.getHttpServer()).delete(`/api${path}`).set('Origin', origin).set('Cookie', cookie);

  it('creates a workflow at version 1 and returns columns and rows', async () => {
    const user = await actor();
    const response = await post(user.cookie, '/workflows', validWorkflow());
    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      name: 'Campaign A',
      version: 1,
      columns: [
        { id: 'ref', name: 'Reference', type: 'reference' },
        {
          id: 'gen',
          name: 'Generation',
          type: 'generation',
          prompt: 'A clean product photo',
          sourceColumnIds: ['ref'],
        },
      ],
      rows: [{ rowKey: 'row-1', cells: { ref: expect.any(String) } }],
    });
  });

  it('lists only the owner workflows and hides archived ones', async () => {
    const alice = await actor();
    const bob = await actor();
    const created = await post(alice.cookie, '/workflows', validWorkflow()).expect(201);
    await post(bob.cookie, '/workflows', validWorkflow()).expect(201);

    const aliceList = await get(alice.cookie, '/workflows');
    expect(aliceList.body.data).toHaveLength(1);
    expect(aliceList.body.data[0]).toMatchObject({ id: created.body.data.id });

    const bobList = await get(bob.cookie, '/workflows');
    expect(bobList.body.data).toHaveLength(1);
    expect(bobList.body.data[0].id).not.toBe(created.body.data.id);

    await del(alice.cookie, `/workflows/${created.body.data.id}`).expect(200);
    const afterArchive = await get(alice.cookie, '/workflows');
    expect(afterArchive.body.data).toHaveLength(0);
  });

  it('scopes detail and commands to the owner', async () => {
    const alice = await actor();
    const bob = await actor();
    const created = await post(alice.cookie, '/workflows', validWorkflow()).expect(201);
    const id = created.body.data.id;

    await get(bob.cookie, `/workflows/${id}`).expect(404);
    await put(bob.cookie, `/workflows/${id}`, { version: 1, ...validWorkflow() }).expect(404);
    await post(bob.cookie, `/workflows/${id}/copy`).expect(404);
    await del(bob.cookie, `/workflows/${id}`).expect(404);
  });

  it('rejects malformed columns and cells with invalid input', async () => {
    const user = await actor();
    const badColumn = {
      name: 'Bad',
      columns: [{ id: 'gen', name: 'Generation', type: 'generation', prompt: 'x', sourceColumnIds: [], modelId: 'm', resolution: '1K', ratio: '1:1', unknown: true }],
      rows: [],
    };
    await post(user.cookie, '/workflows', badColumn).expect(400);

    const badCell = {
      name: 'Bad cells',
      columns: [{ id: 'ref', name: 'Reference', type: 'reference' }],
      rows: [{ rowKey: 'row-1', cells: { ref: 42 } }],
    };
    await post(user.cookie, '/workflows', badCell).expect(400);
  });

  it('rejects duplicate column and row keys as an invalid graph', async () => {
    const user = await actor();
    const duplicateColumns = {
      name: 'Dup columns',
      columns: [
        { id: 'ref', name: 'A', type: 'reference' },
        { id: 'ref', name: 'B', type: 'reference' },
      ],
      rows: [],
    };
    await post(user.cookie, '/workflows', duplicateColumns).expect(422);

    const duplicateRows = {
      name: 'Dup rows',
      columns: [{ id: 'ref', name: 'Reference', type: 'reference' }],
      rows: [
        { rowKey: 'row-1', cells: {} },
        { rowKey: 'row-1', cells: {} },
      ],
    };
    await post(user.cookie, '/workflows', duplicateRows).expect(422);
  });

  it('rejects dangling and cross-output source columns', async () => {
    const user = await actor();
    const dangling = {
      name: 'Dangling',
      columns: [
        {
          id: 'gen',
          name: 'Generation',
          type: 'generation',
          prompt: 'x',
          sourceColumnIds: ['missing'],
          modelId: 'm',
          resolution: '1K',
          ratio: '1:1',
        },
      ],
      rows: [],
    };
    await post(user.cookie, '/workflows', dangling).expect(422);

    const crossOutput = {
      name: 'Cross output',
      columns: [
        {
          id: 'gen-a',
          name: 'Generation A',
          type: 'generation',
          prompt: 'x',
          sourceColumnIds: [],
          modelId: 'm',
          resolution: '1K',
          ratio: '1:1',
        },
        {
          id: 'gen-b',
          name: 'Generation B',
          type: 'generation',
          prompt: 'y',
          sourceColumnIds: ['gen-a'],
          modelId: 'm',
          resolution: '1K',
          ratio: '1:1',
        },
      ],
      rows: [],
    };
    await post(user.cookie, '/workflows', crossOutput).expect(422);
  });

  it('updates in place, replaces rows, and increments the version', async () => {
    const user = await actor();
    const created = await post(user.cookie, '/workflows', validWorkflow()).expect(201);
    const id = created.body.data.id;

    const updated = await put(user.cookie, `/workflows/${id}`, {
      version: 1,
      name: 'Campaign B',
      columns: [{ id: 'ref', name: 'Reference', type: 'reference' }],
      rows: [
        { rowKey: 'row-1', cells: { ref: randomUUID() } },
        { rowKey: 'row-2', cells: {} },
      ],
    });
    expect(updated.status).toBe(200);
    expect(updated.body.data).toMatchObject({ version: 2, name: 'Campaign B' });
    expect(updated.body.data.rows.map((row: { rowKey: string }) => row.rowKey)).toEqual([
      'row-1',
      'row-2',
    ]);

    const detail = await get(user.cookie, `/workflows/${id}`).expect(200);
    expect(detail.body.data).toMatchObject({ version: 2, name: 'Campaign B' });
  });

  it('rejects a stale version with a conflict', async () => {
    const user = await actor();
    const created = await post(user.cookie, '/workflows', validWorkflow()).expect(201);
    const id = created.body.data.id;

    await put(user.cookie, `/workflows/${id}`, { version: 1, ...validWorkflow() }).expect(200);
    const stale = await put(user.cookie, `/workflows/${id}`, { version: 1, ...validWorkflow() });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('WORKFLOW_VERSION_CONFLICT');
  });

  it('copies a workflow into a fresh version 1 with distinct id', async () => {
    const user = await actor();
    const created = await post(user.cookie, '/workflows', validWorkflow()).expect(201);
    const copy = await post(user.cookie, `/workflows/${created.body.data.id}/copy`).expect(201);

    expect(copy.body.data.id).not.toBe(created.body.data.id);
    expect(copy.body.data).toMatchObject({
      name: 'Campaign A (副本)',
      version: 1,
      columns: created.body.data.columns,
      rows: created.body.data.rows,
    });
  });

  it('archives a workflow without removing its runs', async () => {
    const user = await actor();
    const created = await post(user.cookie, '/workflows', validWorkflow()).expect(201);
    const id = created.body.data.id;

    await del(user.cookie, `/workflows/${id}`).expect(200);
    await get(user.cookie, `/workflows/${id}`).expect(404);
    const persisted = await db.database.client.workflow.findUniqueOrThrow({ where: { id } });
    expect(persisted.archivedAt).not.toBeNull();
  });
});
