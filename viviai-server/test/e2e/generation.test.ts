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
import type { GenerationService } from '../../src/modules/generation/generation.service.js';
type JobDto = Awaited<ReturnType<GenerationService['get']>>;

describe.each(['success', 'failure', 'unknown'] as const)(
  'real HTTP + PostgreSQL + Redis: %s',
  (outcome) => {
    let db: TestDatabase;
    let app: INestApplication;
    let root: string;
    let queue: QueueRuntime;
    let base: string;
    beforeAll(async () => {
      db = await createTestDatabase();
      root = await mkdtemp(join(tmpdir(), 'viviai-e2e-'));
      app = await createApp({
        nodeEnv: 'test',
        databaseUrl: db.url,
        localStorageRoot: join(root, 'images'),
        devMailboxRoot: join(root, 'mail'),
      });
      await app.listen(0, '127.0.0.1');
      base = await app.getUrl();
      const store = app.get<ObjectStore>(ASSET_STORE);
      const adapter = new SimulatedProvider(store, 'async');
      if (outcome === 'failure')
        adapter.submit = async () => ({
          kind: 'rejected',
          failure: {
            code: 'content_rejected',
            acceptance: 'not_accepted',
            billing: 'not_billable',
            safeMessage: 'Simulated failure',
          },
        });
      if (outcome === 'unknown')
        adapter.submit = async () => ({
          kind: 'unknown',
          failure: {
            code: 'timeout',
            acceptance: 'unknown',
            billing: 'unknown',
            safeMessage: 'Simulated unknown',
          },
        });
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
      if (errors.length) throw new AggregateError(errors, 'Smoke teardown failed');
    });
    it('verifies account, uploads role images, quotes, submits once, polls and settles correctly', async () => {
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
      await post('auth/send-code', { email: 'smoke@example.test' });
      const files = await readdir(join(root, 'mail'));
      const mail = JSON.parse(await readFile(join(root, 'mail', files[0]!), 'utf8'));
      const user = await post<{ id: string }>('auth/register', {
        email: 'smoke@example.test',
        username: 'smoke',
        password: 'smoke-test-password-only',
        code: mail.code,
      });
      await db.database.transaction((tx) =>
        new WalletService(db.database).grant(tx, user.id, 'smoke-promo', 1000n, null),
      );
      const assets: AssetDto[] = [];
      for (const color of ['red', 'blue']) {
        const bytes = await sharp({
          create: { width: 16, height: 24, channels: 3, background: color },
        })
          .png()
          .toBuffer();
        const form = new FormData();
        form.set('file', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), `${color}.png`);
        const response = await fetch(`${base}/api/remix-references`, {
          method: 'POST',
          headers: { Origin: origin, Cookie: cookie },
          body: form,
        });
        expect(response.status).toBe(201);
        assets.push((await jsonEnvelope<AssetDto>(response)).data);
      }
      const input = {
        source: 'remix',
        modelId: 'simulation-image-v1',
        prompt: 'Create a new composition',
        count: 1,
        referenceAssetId: assets[0]!.id,
        subjectAssetId: assets[1]!.id,
        strength: 'balanced',
      };
      const quote = await post<{ id: string }>('generation-quotes', input);
      const key = randomUUID();
      const body = { quoteId: quote.id, input };
      const [first, second] = await Promise.all([
        post<JobDto>('remix-tasks', body, key),
        post<JobDto>('remix-tasks', body, key),
      ]);
      expect(first.id).toBe(second.id);
      let result = first;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        result = (
          await jsonEnvelope<JobDto>(
            await fetch(`${base}/api/generation-tasks/${first.id}`, {
              headers: { Cookie: cookie },
            }),
          )
        ).data;
        if (outcome === 'unknown' && result.stage === 'unknown')
          await db.database.client.generationJob.update({
            where: { id: first.id },
            data: { deliveryDeadlineAt: new Date(0) },
          });
        if (['succeeded', 'failed'].includes(result.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(result.status).toBe(outcome === 'success' ? 'succeeded' : 'failed');
      expect(result.chargedCredits).toBe(outcome === 'success' ? 30 : 0);
      const attempts = await db.database.client.providerAttempt.findMany({
        where: { itemId: first.items[0]!.id },
      });
      expect(attempts).toHaveLength(1);
      expect(queue.deliveries).toBeGreaterThan(0);
      expect(
        (attempts[0]!.request as { images: Array<{ role: string }> }).images.map(
          (image) => image.role,
        ),
      ).toEqual(['reference', 'subject']);
      if (outcome === 'success') {
        const response = await fetch(`${base}/api/assets/${result.resultAssetIds[0]}/content`, {
          headers: { Cookie: cookie },
        });
        expect(response.status).toBe(200);
        expect(await sharp(Buffer.from(await response.arrayBuffer())).metadata()).toMatchObject({
          width: 1024,
          height: 1024,
          format: 'png',
        });
        expect((await fetch(`${base}/api/assets/${result.resultAssetIds[0]}/content`)).status).toBe(
          401,
        );
      }
      const me = (
        await jsonEnvelope<{ credits: number; frozenCredits: number }>(
          await fetch(`${base}/api/me`, { headers: { Cookie: cookie } }),
        )
      ).data;
      expect(me).toMatchObject({ credits: outcome === 'success' ? 970 : 1000, frozenCredits: 0 });
      const ledger = (
        await jsonEnvelope<Array<{ type: string }>>(
          await fetch(`${base}/api/point-ledger`, { headers: { Cookie: cookie } }),
        )
      ).data;
      expect(
        ledger.some(
          (entry: { type: string }) =>
            entry.type === (outcome === 'success' ? 'consume' : 'release'),
        ),
      ).toBe(true);
    }, 20_000);
  },
);
