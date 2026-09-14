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
import type { RunDto } from '../../src/modules/workflow/batch-projection.service.js';
import type { WorkflowDto } from '../../src/modules/workflow/workflow-presenter.js';

/** The prompt the stubbed transport rejects until the test explicitly heals it. */
const REJECTED_PROMPT = 'A wide banner that the upstream rejects';
/**
 * The simulated refusal. `invalid_input` is terminal for a single channel yet still
 * retryable for a batch, which is what an operator retry is for.
 */
const REJECTION = {
  code: 'invalid_input',
  acceptance: 'not_accepted',
  billing: 'not_billable',
  safeMessage: 'Simulated provider refusal',
} as const;
const UNIT_CREDITS = 30;
const FUNDED_CREDITS = 1000;

describe('workflow batches end to end', () => {
  let db: TestDatabase;
  let app: INestApplication;
  let root: string;
  let queue: QueueRuntime;
  let base: string;
  /** Prompts the stubbed transport refuses; cleared before the retry is submitted. */
  const rejected = new Set([REJECTED_PROMPT]);

  beforeAll(async () => {
    db = await createTestDatabase();
    root = await mkdtemp(join(tmpdir(), 'viviai-workflow-e2e-'));
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
    const submit = adapter.submit.bind(adapter);
    adapter.submit = (request, context) =>
      [...rejected].some((prompt) => request.prompt.includes(prompt))
        ? Promise.resolve({ kind: 'rejected', failure: REJECTION })
        : submit(request, context);
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
    if (errors.length) throw new AggregateError(errors, 'Workflow E2E teardown failed');
  });

  it('runs a multi-row batch, settles exactly, retries only the failure and keeps the original history', async () => {
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
    async function get<T>(path: string): Promise<T> {
      const result = await jsonEnvelope<T>(
        await fetch(`${base}/api/${path}`, { headers: { Cookie: cookie } }),
      );
      return result.data;
    }
    /** Batch runs settle asynchronously, so every assertion waits for a terminal run. */
    async function settle(runId: string): Promise<RunDto> {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const run = await get<RunDto>(`workflow-runs/${runId}`);
        if (['succeeded', 'partial', 'failed', 'cancelled'].includes(run.status)) return run;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`Batch ${runId} never settled`);
    }
    const wallet = () => get<{ credits: number; frozenCredits: number }>('me');

    await post('auth/send-code', { email: 'workflow@example.test' });
    const files = await readdir(join(root, 'mail'));
    const mail = JSON.parse(await readFile(join(root, 'mail', files[0]!), 'utf8'));
    const user = await post<{ id: string }>('auth/register', {
      email: 'workflow@example.test',
      username: 'workflow_e2e',
      password: 'workflow-test-password-only',
      code: mail.code,
    });
    await db.database.transaction((tx) =>
      new WalletService(db.database).grant(tx, user.id, 'workflow-e2e-promo', 1000n, null),
    );

    const bytes = await sharp({
      create: { width: 16, height: 24, channels: 3, background: 'green' },
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

    // One reference column feeding two output columns: the same row yields one
    // image the transport accepts and one it refuses.
    const workflow = await post<WorkflowDto>('workflows', {
      name: 'e2e batch workflow',
      columns: [
        { id: 'shot', name: '产品图', type: 'reference' },
        {
          id: 'hero',
          name: '主图',
          type: 'generation',
          prompt: 'A clean studio hero shot',
          sourceColumnIds: ['shot'],
          modelId: 'simulation-image-v1',
          resolution: '1K',
          ratio: '1:1',
        },
        {
          id: 'banner',
          name: '横幅',
          type: 'generation',
          prompt: REJECTED_PROMPT,
          sourceColumnIds: ['shot'],
          modelId: 'simulation-image-v1',
          resolution: '1K',
          ratio: '1:1',
        },
      ],
      rows: [{ rowKey: 'row_a', cells: { shot: asset.id } }],
    });
    expect(workflow.version).toBe(1);

    // The saved workflow survives a round trip through the API unchanged.
    const reloaded = await get<WorkflowDto>(`workflows/${workflow.id}`);
    expect(reloaded).toMatchObject({
      id: workflow.id,
      version: 1,
      columns: workflow.columns,
      rows: workflow.rows,
    });

    const quote = await post<{ quoteId: string; totalCredits: number; submittable: boolean }>(
      'workflow-run-quotes',
      { workflowId: workflow.id, rowIds: ['row_a'] },
    );
    expect(quote).toMatchObject({ submittable: true, totalCredits: UNIT_CREDITS * 2 });

    const runKey = randomUUID();
    const submitted = await post<RunDto>('workflow-runs', { quoteId: quote.quoteId }, runKey);
    // The same key replays the same batch instead of freezing credits twice.
    const replayed = await post<RunDto>('workflow-runs', { quoteId: quote.quoteId }, runKey);
    expect(replayed.id).toBe(submitted.id);

    const run = await settle(submitted.id);
    expect(run).toMatchObject({
      workflowId: workflow.id,
      workflowName: 'e2e batch workflow',
      workflowVersion: 1,
      status: 'partial',
      totalCount: 2,
      succeededCount: 1,
      failedCount: 1,
      cancelledCount: 0,
      estimatedCredits: UNIT_CREDITS * 2,
      chargedCredits: UNIT_CREDITS,
      retryOfRunId: null,
    });
    const succeeded = run.items.find((item) => item.status === 'succeeded')!;
    const failed = run.items.find((item) => item.status === 'failed')!;
    expect(succeeded).toMatchObject({ columnKey: 'hero', columnName: '主图', retryable: true });
    expect(succeeded.resultAssetIds).toHaveLength(1);
    expect(failed).toMatchObject({
      columnKey: 'banner',
      columnName: '横幅',
      errorCode: 'PROVIDER_INVALID_INPUT',
      retryable: true,
    });
    expect(failed.resultAssetIds).toEqual([]);
    // Only the delivered image is billed; the refused one released its freeze.
    expect(await wallet()).toMatchObject({
      credits: FUNDED_CREDITS - UNIT_CREDITS,
      frozenCredits: 0,
    });
    const ledger = await get<Array<{ type: string }>>('point-ledger');
    expect(ledger.filter((entry) => entry.type === 'consume')).toHaveLength(1);
    expect(ledger.filter((entry) => entry.type === 'release')).toHaveLength(1);

    const assetResponse = await fetch(`${base}/api/assets/${succeeded.resultAssetIds[0]}/content`, {
      headers: { Cookie: cookie },
    });
    expect(assetResponse.status).toBe(200);
    expect(await sharp(Buffer.from(await assetResponse.arrayBuffer())).metadata()).toMatchObject({
      width: 1024,
      height: 1024,
      format: 'png',
    });

    const notification = await db.database.client.notification.findMany({
      where: { userId: user.id, eventKey: `generation-terminal:${succeeded.generationJobId}` },
    });
    expect(notification).toHaveLength(1);
    expect(notification[0]).toMatchObject({
      type: 'task',
      title: '任务完成',
      body: '图片已全部生成。',
    });

    // The upstream recovers, and the retry re-quotes only the failed column.
    rejected.clear();
    const retryQuote = await post<{
      quoteId: string;
      submittable: boolean;
      totalCredits: number;
      items: Array<{ rowKey: string; columnId: string }>;
    }>('workflow-run-quotes', { retryRunId: run.id });
    expect(retryQuote).toMatchObject({ submittable: true, totalCredits: UNIT_CREDITS });
    expect(retryQuote.items).toEqual([
      expect.objectContaining({ rowKey: 'row_a', columnId: 'banner' }),
    ]);

    const retry = await settle(
      (
        await post<RunDto>(
          `workflow-runs/${run.id}/retry-failed`,
          { quoteId: retryQuote.quoteId },
          randomUUID(),
        )
      ).id,
    );
    expect(retry).toMatchObject({
      workflowId: workflow.id,
      workflowVersion: 1,
      status: 'succeeded',
      totalCount: 1,
      succeededCount: 1,
      failedCount: 0,
      chargedCredits: UNIT_CREDITS,
      retryOfRunId: run.id,
    });
    expect(await wallet()).toMatchObject({
      credits: FUNDED_CREDITS - UNIT_CREDITS * 2,
      frozenCredits: 0,
    });

    // The original run's history is frozen: only its retry link was added.
    const original = await get<RunDto>(`workflow-runs/${run.id}`);
    expect(original).toMatchObject({
      status: 'partial',
      totalCount: 2,
      succeededCount: 1,
      failedCount: 1,
      chargedCredits: UNIT_CREDITS,
      retryRunIds: [retry.id],
    });
    expect(original.items.map((item) => item.id)).toEqual(run.items.map((item) => item.id));
    expect(original.items.map((item) => item.generationJobId)).toEqual(
      run.items.map((item) => item.generationJobId),
    );
    expect(original.childTaskIds).toEqual(run.childTaskIds);
    // The retry ran fresh tasks from the frozen snapshot, never the original ones.
    expect(retry.childTaskIds.filter((id) => run.childTaskIds.includes(id))).toEqual([]);
    expect(queue.deliveries).toBeGreaterThan(0);
  }, 60_000);
});
