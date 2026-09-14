import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { INestApplication } from '@nestjs/common';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';
import { createApp } from '../../src/main.js';
import { WalletService } from '../../src/modules/wallet/wallet.service.js';
import { ASSET_STORE } from '../../src/modules/assets/assets.service.js';
import type { ObjectStore } from '../../src/modules/assets/object-store.js';
import { ProviderRegistry } from '../../src/modules/providers/registry.js';
import { SimulatedProvider } from '../../src/modules/providers/simulated-provider.js';
import { SIMULATED_PROFILES } from '../../src/modules/providers/provider-config.js';
import { DispatchService } from '../../src/modules/generation/dispatch.service.js';
import { QueueRuntime } from '../../src/shared/queue/queue-runtime.js';
import { jsonEnvelope } from '../helpers/http.js';
import type { AssetDto } from '../../src/modules/assets/assets.service.js';

const toolExternalId = 'e2e-product-background';

interface ToolJobDto {
  id: string;
  toolId?: string;
  toolVersion?: number;
  status: string;
  chargedCredits: number;
  resultAssetIds: string[];
}

describe('quoted AI tool execution end to end', () => {
  let db: TestDatabase;
  let app: INestApplication;
  let root: string;
  let queue: QueueRuntime;
  let base: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    root = await mkdtemp(join(tmpdir(), 'viviai-tool-e2e-'));
    app = await createApp({
      nodeEnv: 'test',
      databaseUrl: db.url,
      localStorageRoot: join(root, 'images'),
      devMailboxRoot: join(root, 'mail'),
    });
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    await db.database.client.toolDefinition.create({
      data: {
        externalId: toolExternalId,
        name: 'Product Background',
        description: 'Generate on-brand product backgrounds',
        category: 'Product',
        fieldSchema: [{ id: 'subject', label: 'Subject', type: 'text', required: true }],
        promptTemplate: 'A clean product photo of {{subject}}',
        defaults: { modelId: 'simulation-image-v1', resolution: '1K', ratio: '1:1', count: 1 },
        maxAssets: 1,
        assetLabel: 'Product image',
        defaultModelId: 'simulation-image-v1',
        defaultOutputSpecId: 'standard',
        status: 'published',
        version: 1,
      },
    });
    const store = app.get<ObjectStore>(ASSET_STORE);
    const adapter = new SimulatedProvider(store, 'async');
    const registry = new ProviderRegistry(store, [{ profile: SIMULATED_PROFILES[0]!, adapter }]);
    queue = new QueueRuntime(
      db.database,
      new DispatchService(db.database, new WalletService(db.database), store, registry),
      process.env.REDIS_URL!,
      `test-${randomUUID()}`,
    );
    await queue.start(100);
  });

  afterAll(async () => {
    const errors: unknown[] = [];
    for (const cleanup of [
      () => queue?.close(),
      () => queue?.cleanupOwnedTestQueue(),
      () => app?.close(),
      () => db?.cleanup(),
      () => (root ? rm(root, { recursive: true, force: true }) : undefined),
    ])
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    if (errors.length) throw new AggregateError(errors, 'Tool E2E teardown failed');
  });

  it('quotes, executes, settles and notifies a single tool run', async () => {
    let cookie = '';
    const origin = 'http://localhost:3000';
    async function post<T>(path: string, body: unknown, key?: string): Promise<T> {
      const response = await fetch(`${base}/api/${path}`, {
        method: 'POST',
        headers: {
          Origin: origin,
          'Content-Type': 'application/json',
          Cookie: cookie,
          ...(key ? { 'Idempotency-Key': key } : {}),
        },
        body: JSON.stringify(body),
      });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0]!;
      const result = await jsonEnvelope<T>(response);
      expect(response.status, JSON.stringify(result)).toBeLessThan(400);
      return result.data;
    }

    await post('auth/send-code', { email: 'tool@example.test' });
    const files = await readdir(join(root, 'mail'));
    const mail = JSON.parse(await readFile(join(root, 'mail', files[0]!), 'utf8'));
    const user = await post<{ id: string }>('auth/register', {
      email: 'tool@example.test',
      username: 'tool_e2e',
      password: 'tool-test-password-only',
      code: mail.code,
    });
    await db.database.transaction((tx) =>
      new WalletService(db.database).grant(tx, user.id, 'tool-e2e-promo', 1000n, null),
    );

    const bytes = await sharp({
      create: { width: 16, height: 24, channels: 3, background: 'blue' },
    })
      .png()
      .toBuffer();
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), 'reference.png');
    const upload = await fetch(`${base}/api/remix-references`, {
      method: 'POST',
      headers: { Origin: origin, Cookie: cookie },
      body: form,
    });
    expect(upload.status).toBe(201);
    const asset = (await jsonEnvelope<AssetDto>(upload)).data;

    const quote = await post<{ quoteId: string; totalCredits: number }>('tool-run-quotes', {
      toolId: toolExternalId,
      toolVersion: 1,
      assetIds: [asset.id],
      values: { subject: 'a perfume bottle' },
      modelId: 'simulation-image-v1',
      resolution: '1K',
      ratio: '1:1',
      count: 1,
    });
    expect(quote.totalCredits).toBe(30);

    const job = await post<ToolJobDto>('tool-runs', { quoteId: quote.quoteId }, randomUUID());

    let result = job;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      result = (
        await jsonEnvelope<ToolJobDto>(
          await fetch(`${base}/api/generation-tasks/${job.id}`, {
            headers: { Cookie: cookie },
          }),
        )
      ).data;
      if (['succeeded', 'failed', 'partial', 'cancelled'].includes(result.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(result.status).toBe('succeeded');
    expect(result.toolId).toBe(toolExternalId);
    expect(result.toolVersion).toBe(1);
    expect(result.chargedCredits).toBe(30);
    expect(result.resultAssetIds).toHaveLength(1);

    const assetResponse = await fetch(`${base}/api/assets/${result.resultAssetIds[0]}/content`, {
      headers: { Cookie: cookie },
    });
    expect(assetResponse.status).toBe(200);
    expect(await sharp(Buffer.from(await assetResponse.arrayBuffer())).metadata()).toMatchObject({
      width: 1024,
      height: 1024,
      format: 'png',
    });

    const persisted = await db.database.client.generationJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    expect(persisted.originType).toBe('tool');
    expect(persisted.originId).toBe(toolExternalId);
    expect(persisted.originVersion).toBe(1);

    const me = (
      await jsonEnvelope<{ credits: number; frozenCredits: number }>(
        await fetch(`${base}/api/me`, { headers: { Cookie: cookie } }),
      )
    ).data;
    expect(me).toMatchObject({ credits: 970, frozenCredits: 0 });

    const notifications = await db.database.client.notification.findMany({
      where: { userId: user.id, eventKey: `generation-terminal:${job.id}` },
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ type: 'task', title: '任务完成' });
  }, 20_000);
});
