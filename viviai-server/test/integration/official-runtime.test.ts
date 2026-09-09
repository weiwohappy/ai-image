import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';
import { createTestStorage } from '../helpers/storage.js';
import { loadConfig } from '../../src/config.js';
import { loadOfficialConfig } from '../../src/modules/providers/official-config.js';
import { buildProviderRegistry } from '../../src/modules/providers/official-runtime.js';
import { CatalogService } from '../../src/modules/catalog/catalog.service.js';
import { GenerationService } from '../../src/modules/generation/generation.service.js';
import { WalletService } from '../../src/modules/wallet/wallet.service.js';
import { DispatchService } from '../../src/modules/generation/dispatch.service.js';
import { officialSpecs } from '../../src/modules/providers/official-models.js';

describe('official model runtime with offline provider boundary', () => {
  let db: TestDatabase;
  let storage: Awaited<ReturnType<typeof createTestStorage>>;
  beforeAll(async () => {
    db = await createTestDatabase();
    storage = await createTestStorage();
  });
  afterAll(async () => {
    await storage?.cleanup();
    await db?.cleanup();
  });
  async function setup(
    complete = true,
    width = 1024,
    height = 1024,
    modelId = 'gpt-image-2',
    resolution = '1K',
    ratio = '1:1',
  ) {
    const provider = modelId === 'gpt-image-2' ? 'openai' : 'google';
    const userId = randomUUID();
    await db.database.client.user.create({
      data: { id: userId, email: `${userId}@test.local`, username: userId, passwordHash: 'unused' },
    });
    const wallet = new WalletService(db.database);
    await db.database.transaction((tx) => wallet.grant(tx, userId, 'offline', 1000n, null));
    const official = loadOfficialConfig({
      OPENAI_API_KEY: 'offline-key',
      GEMINI_API_KEY: 'offline-key',
      OFFICIAL_IMAGE_MODELS_JSON: JSON.stringify({
        revision: 'offline-v1',
        accounts: {
          [provider]: {
            scope: userId,
            credentialVersion: 'v1',
            concurrency: 1,
            maxUnknown: 1,
            dailyBudgetMicros: '10000000',
          },
        },
        models: [
          {
            modelId,
            sales: Object.fromEntries(
              [...new Set(officialSpecs(modelId).map((s) => s.resolution))].map((r) => [
                r,
                r === '1K' ? 100 : 200,
              ]),
            ),
            reserveCostMicros: '1000000',
            pricing: {
              version: 'test-not-real-prices',
              currency: 'USD',
              rates: {
                input_text_tokens: '5000000',
                input_image_tokens: '10000000',
                output_text_tokens: '5000000',
                output_image_tokens: '30000000',
                ...(provider === 'google' ? { thought_tokens: '5000000' } : {}),
              },
            },
          },
        ],
      }),
    });
    const config = { ...loadConfig(), officialImages: official, simulationProviderEnabled: false };
    const catalog = new CatalogService(db.database, config);
    const jobs = new GenerationService(db.database, catalog, wallet);
    const bytes = await sharp({ create: { width, height, channels: 3, background: 'blue' } })
      .png()
      .toBuffer();
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify(
            provider === 'google'
              ? {
                  id: randomUUID(),
                  status: 'completed',
                  steps: [
                    {
                      type: 'model_output',
                      content: [
                        { type: 'image', mime_type: 'image/png', data: bytes.toString('base64') },
                      ],
                    },
                  ],
                  usage: {
                    input_tokens_by_modality: [{ modality: 'text', tokens: 10 }],
                    output_tokens_by_modality: [{ modality: 'image', tokens: 100 }],
                    total_input_tokens: 10,
                    total_output_tokens: 100,
                    total_tokens: 110,
                    total_thought_tokens: 0,
                    total_cached_tokens: 0,
                    total_tool_use_tokens: 0,
                  },
                }
              : {
                  data: [{ b64_json: bytes.toString('base64') }],
                  ...(complete
                    ? {
                        usage: {
                          input_tokens: 10,
                          input_tokens_details: { text_tokens: 10, image_tokens: 0 },
                          output_tokens: 100,
                          output_tokens_details: { text_tokens: 0, image_tokens: 100 },
                          total_tokens: 110,
                        },
                      }
                    : {}),
                },
          ),
          { status: 200, headers: { 'x-request-id': randomUUID() } },
        ),
    );
    const registry = buildProviderRegistry(config, storage.store, fetcher);
    const dispatch = new DispatchService(db.database, wallet, storage.store, registry);
    const input = { modelId, resolution, ratio, prompt: 'blue cup', count: 1 };
    const quote = await catalog.quote(userId, input);
    const job = await jobs.create(userId, { quoteId: quote.id, input }, randomUUID(), 'create');
    return {
      userId,
      wallet,
      config,
      catalog,
      jobs,
      fetcher,
      registry,
      dispatch,
      input,
      quote,
      job,
      id: job.items[0]!.id,
    };
  }
  it.each([
    'gemini-2.5-flash-image',
    'gemini-3.1-flash-lite-image',
    'gemini-3.1-flash-image',
    'gemini-3-pro-image',
  ])('routes and accounts for exact Google model %s', async (modelId) => {
    const s = await setup(true, 1024, 1024, modelId);
    await s.dispatch.process(s.id);
    expect(s.fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(s.fetcher.mock.calls[0]![1]!.body)).model).toBe(modelId);
    expect((await s.jobs.get(s.userId, s.job.id)).status).toBe('succeeded');
    const attempt = await db.database.client.providerAttempt.findFirstOrThrow({
      where: { itemId: s.id },
      include: { usage: true },
    });
    expect(attempt.usage).toMatchObject({ simulated: false, actualCostMicros: 3050n });
  });
  it('preserves Google published 2K landscape pixels through quote, adapter and asset', async () => {
    const s = await setup(true, 2752, 1536, 'gemini-3.1-flash-image', '2K', '16:9');
    await s.dispatch.process(s.id);
    const job = await s.jobs.get(s.userId, s.job.id);
    expect(job.status).toBe('succeeded');
    expect(
      await db.database.client.asset.findUniqueOrThrow({ where: { id: job.resultAssetIds[0]! } }),
    ).toMatchObject({ width: 2752, height: 1536 });
    expect(JSON.parse(String(s.fetcher.mock.calls[0]![1]!.body)).response_format).toMatchObject({
      aspect_ratio: '16:9',
      image_size: '2K',
    });
  });
  it('freezes official pricing and produces a private non-simulation asset, charging once', async () => {
    const s = await setup();
    const quote = await db.database.client.generationQuote.findUniqueOrThrow({
      where: { id: s.quote.id },
    });
    expect(quote.execution).toMatchObject({
      upstreamModelId: 'gpt-image-2',
      width: 1024,
      height: 1024,
    });
    expect(JSON.stringify(s.catalog.models())).not.toContain('offline-key');
    expect(s.catalog.models()[0]).toMatchObject({ simulated: false, specs: expect.any(Array) });
    await s.dispatch.process(s.id);
    await s.dispatch.process(s.id);
    expect(s.fetcher).toHaveBeenCalledTimes(1);
    expect(await s.wallet.balance(s.userId)).toMatchObject({
      available: 900n,
      held: 0n,
      consumed: 100n,
    });
    const result = await db.database.client.generationItem.findUniqueOrThrow({
      where: { id: s.id },
      include: { attempts: { include: { usage: true } } },
    });
    expect(result.status).toBe('succeeded');
    expect(result.attempts[0]!.usage).toMatchObject({ simulated: false, actualCostMicros: 3050n });
    const asset = await db.database.client.asset.findUniqueOrThrow({
      where: { id: result.resultAssetId! },
    });
    expect(asset).toMatchObject({ source: 'generation', width: 1024, height: 1024 });
    expect(asset.name).not.toContain('模拟');
  });
  it('delivers image with incomplete usage but reserves budget and leaves actual cost unknown', async () => {
    const s = await setup(false);
    await s.dispatch.process(s.id);
    const attempt = await db.database.client.providerAttempt.findFirstOrThrow({
      where: { itemId: s.id },
      include: { usage: true },
    });
    expect(attempt.usage).toMatchObject({
      simulated: false,
      certainty: 'unknown',
      actualCostMicros: null,
    });
    expect(attempt.slotActive).toBe(false);
    expect(
      await db.database.client.providerBudget.findUniqueOrThrow({
        where: { id: attempt.budgetKey },
      }),
    ).toMatchObject({ reservedMicros: 1000000n, consumedMicros: 0n });
    expect((await s.jobs.get(s.userId, s.job.id)).status).toBe('succeeded');
  });
  it('rejects output dimensions differing from quotation without consuming user credits', async () => {
    const s = await setup(true, 512, 512);
    await s.dispatch.process(s.id);
    expect((await s.jobs.get(s.userId, s.job.id)).status).toBe('failed');
    expect(await s.wallet.balance(s.userId)).toMatchObject({ available: 1000n, held: 0n });
    expect(s.fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects execution after config drift rather than substituting model/price', async () => {
    const s = await setup();
    s.config.officialImages.models[0]!.sales['1K'] = 101;
    const drifted = buildProviderRegistry(s.config, storage.store, s.fetcher);
    await new DispatchService(db.database, s.wallet, storage.store, drifted).process(s.id);
    expect(s.fetcher).not.toHaveBeenCalled();
    expect((await s.jobs.get(s.userId, s.job.id)).status).toBe('failed');
    expect(await s.wallet.balance(s.userId)).toMatchObject({ available: 1000n, held: 0n });
  });
  it('requires requoting when prices change before acceptance', async () => {
    const s = await setup();
    const quote = await s.catalog.quote(s.userId, s.input);
    s.config.officialImages.models[0]!.sales['1K'] = 102;
    await expect(
      s.jobs.create(s.userId, { quoteId: quote.id, input: s.input }, randomUUID(), 'create'),
    ).rejects.toMatchObject({ code: 'MODEL_CONFIG_CHANGED' });
    expect(await s.wallet.balance(s.userId)).toMatchObject({ available: 900n, held: 100n });
  });
  it('recovers final transaction failure from staged bytes without another paid submission', async () => {
    const s = await setup();
    const settle = vi
      .spyOn(s.wallet, 'settle')
      .mockRejectedValueOnce(new Error('Injected transaction interruption'));
    await s.dispatch.process(s.id);
    const attempt = await db.database.client.providerAttempt.findFirstOrThrow({
      where: { itemId: s.id },
    });
    expect(attempt.stagedKey).toBeTruthy();
    settle.mockRestore();
    await db.database.client.generationItem.update({
      where: { id: s.id },
      data: { nextRunAt: new Date(0), leaseUntil: null },
    });
    const read = vi
      .spyOn(storage.store, 'get')
      .mockRejectedValueOnce(new Error('Transient object read failure'));
    await s.dispatch.process(s.id);
    expect((await s.jobs.get(s.userId, s.job.id)).stage).toBe('materializing');
    read.mockRestore();
    await db.database.client.generationItem.update({
      where: { id: s.id },
      data: { nextRunAt: new Date(0), leaseUntil: null },
    });
    await s.dispatch.process(s.id);
    expect((await s.jobs.get(s.userId, s.job.id)).status).toBe('succeeded');
    expect(s.fetcher).toHaveBeenCalledTimes(1);
    expect(await s.wallet.balance(s.userId)).toMatchObject({ consumed: 100n, held: 0n });
  });
  it('does not resubmit a network-unknown request; timeout is longer than the old 30s lease', async () => {
    const s = await setup();
    let unblock!: () => void;
    let called!: () => void;
    const started = new Promise<void>((resolve) => {
      called = resolve;
    });
    s.fetcher.mockImplementation(async () => {
      called();
      await new Promise<void>((resolve) => {
        unblock = resolve;
      });
      throw new Error('network lost');
    });
    const processing = s.dispatch.process(s.id);
    await started;
    const pending = await db.database.client.generationItem.findUniqueOrThrow({
      where: { id: s.id },
    });
    expect(pending.leaseUntil!.getTime() - Date.now()).toBeGreaterThan(180000);
    unblock();
    await processing;
    await db.database.client.generationItem.update({
      where: { id: s.id },
      data: { nextRunAt: new Date(0) },
    });
    await s.dispatch.process(s.id);
    expect(s.fetcher).toHaveBeenCalledTimes(1);
    expect((await s.jobs.get(s.userId, s.job.id)).items[0]!.status).toBe('unknown');
  });
});
