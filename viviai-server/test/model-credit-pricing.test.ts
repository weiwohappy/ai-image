import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { teamFixture } from './helpers/admin-team.js';
import { adminApp } from './helpers/admin.js';
import { loadOfficialConfig } from '../src/modules/providers/official-config.js';
import { CatalogService } from '../src/modules/catalog/catalog.service.js';
import { GenerationService } from '../src/modules/generation/generation.service.js';
import { WalletService } from '../src/modules/wallet/wallet.service.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { lockCreditPrice } from '../src/modules/catalog/credit-pricing.js';

const officialImages = loadOfficialConfig({
  OPENAI_API_KEY: 'offline-key',
  OFFICIAL_IMAGE_MODELS_JSON: JSON.stringify({
    revision: 'test',
    accounts: {
      openai: {
        scope: 'pricing-test',
        credentialVersion: 'v1',
        concurrency: 1,
        maxUnknown: 1,
        dailyBudgetMicros: '10000000',
      },
    },
    models: [
      {
        modelId: 'gpt-image-2',
        sales: { '1K': 999 },
        reserveCostMicros: '1000000',
        pricing: {
          version: 'test',
          currency: 'USD',
          rates: {
            input_text_tokens: '100',
            input_image_tokens: '100',
            output_text_tokens: '100',
            output_image_tokens: '100',
          },
        },
      },
    ],
  }),
});
describe('authoritative model credit prices', () => {
  let f: Awaited<ReturnType<typeof teamFixture>>;
  let second: Awaited<ReturnType<typeof adminApp>>;
  let userId: string;
  let catalog: CatalogService;
  let jobs: GenerationService;
  let wallet: WalletService;
  const input = {
    modelId: 'gpt-image-2',
    resolution: '1K',
    ratio: '1:1',
    prompt: 'test cup',
    count: 2,
  };
  const path = '/model-pricing/gpt-image-2/1K';
  const save = async (unitCredits: number, enabled: boolean, expectedVersion: number) => {
    const r = await f.call('put', f.superAdmin.cookie, path, {
      unitCredits,
      enabled,
      expectedVersion,
      reason: '测试价格变更说明',
    });
    expect(r.status).toBe(200);
    return r.body.data;
  };
  beforeAll(async () => {
    f = await teamFixture({ officialImages });
    second = await adminApp(f.db, { officialImages });
    catalog = second.get(CatalogService);
    jobs = second.get(GenerationService);
    wallet = second.get(WalletService);
    userId = randomUUID();
    await f.db.database.client.user.create({
      data: { id: userId, email: `${userId}@test.local`, username: userId, passwordHash: 'unused' },
    });
    await f.db.database.transaction((tx) => wallet.grant(tx, userId, 'pricing-test', 10000n, null));
  });
  afterAll(async () => {
    await second?.close();
    await f?.close();
  });
  it('fails closed before a DB price and observes another instance save immediately', async () => {
    expect(await f.db.database.client.modelCreditPrice.count()).toBe(0);
    await expect(catalog.quote(userId, input)).rejects.toMatchObject({
      status: 503,
      code: 'PRICE_UNAVAILABLE',
    });
    expect((await catalog.models()).find((m) => m.id === 'gpt-image-2')).toBeUndefined();
    await save(120, true, 0);
    const quote = await catalog.quote(userId, input);
    expect(quote).toMatchObject({ unitCredits: 120, totalCredits: 240, priceVersion: 1 });
    const stored = await f.db.database.client.generationQuote.findUniqueOrThrow({
      where: { id: quote.id },
    });
    expect(stored.creditPriceSnapshot).toMatchObject({
      modelId: 'gpt-image-2',
      resolution: '1K',
      unitCredits: 120,
      version: 1,
    });
    expect(stored.execution).not.toHaveProperty('unitCredits');
  });
  it('rejects stale and disabled quotes with no job or freeze, but replays a submitted old-price job', async () => {
    const stale = await catalog.quote(userId, input);
    await save(150, true, 1);
    await expect(
      jobs.create(userId, { quoteId: stale.id, input }, randomUUID(), 'create'),
    ).rejects.toMatchObject({ status: 409, code: 'PRICE_CHANGED' });
    expect(await wallet.balance(userId)).toMatchObject({ held: 0n });
    const accepted = await catalog.quote(userId, input);
    const key = randomUUID();
    const job = await jobs.create(userId, { quoteId: accepted.id, input }, key, 'create');
    const disabled = await catalog.quote(userId, input);
    await save(150, false, 2);
    await expect(
      jobs.create(userId, { quoteId: disabled.id, input }, randomUUID(), 'create'),
    ).rejects.toMatchObject({ status: 409, code: 'PRICE_UNAVAILABLE' });
    expect((await jobs.create(userId, { quoteId: accepted.id, input }, key, 'create')).id).toBe(
      job.id,
    );
    expect(await wallet.balance(userId)).toMatchObject({ held: 300n });
    const stored = await f.db.database.client.generationJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    expect(stored.creditPriceSnapshot).toMatchObject({ unitCredits: 150, version: 2 });
  });
  it('rejects legacy null or inconsistent official snapshots without freezing credits', async () => {
    await save(150, true, 3);
    const before = await wallet.balance(userId);
    for (const mutation of [
      Prisma.DbNull,
      {
        priceId: randomUUID(),
        modelId: input.modelId,
        resolution: input.resolution,
        unitCredits: 150,
        version: 4,
      },
    ]) {
      const quote = await catalog.quote(userId, input);
      await f.db.database.client.generationQuote.update({
        where: { id: quote.id },
        data: { creditPriceSnapshot: mutation },
      });
      await expect(
        jobs.create(userId, { quoteId: quote.id, input }, randomUUID(), 'create'),
      ).rejects.toMatchObject({ status: 409, code: 'PRICE_CHANGED' });
    }
    const quote = await catalog.quote(userId, input);
    await f.db.database.client.generationQuote.update({
      where: { id: quote.id },
      data: { totalCredits: 301n },
    });
    await expect(
      jobs.create(userId, { quoteId: quote.id, input }, randomUUID(), 'create'),
    ).rejects.toMatchObject({ code: 'PRICE_CHANGED' });
    expect(await wallet.balance(userId)).toEqual(before);
  });
  it('only commits a quoted old-price job or rejects it during a concurrent reprice', async () => {
    for (let i = 0; i < 4; i++) {
      const current = await f.db.database.client.modelCreditPrice.findUniqueOrThrow({
        where: { modelId_resolution: { modelId: input.modelId, resolution: input.resolution } },
      });
      const quote = await catalog.quote(userId, input);
      const before = await wallet.balance(userId);
      const [submitted, repriced] = await Promise.allSettled([
        jobs.create(userId, { quoteId: quote.id, input }, randomUUID(), 'create'),
        save(current.unitCredits + 10, true, current.version),
      ]);
      expect(repriced.status).toBe('fulfilled');
      if (submitted.status === 'fulfilled') {
        expect((await wallet.balance(userId)).held - before.held).toBe(BigInt(quote.totalCredits));
        expect(submitted.value.estimatedCredits).toBe(quote.totalCredits);
      } else {
        expect(submitted.reason).toMatchObject({ code: 'PRICE_CHANGED' });
        expect(await wallet.balance(userId)).toEqual(before);
      }
    }
  });
  it('quote reads a newly committed price when another transaction owns its price lock', async () => {
    let release!: () => void;
    let held!: () => void;
    const locked = new Promise<void>((r) => {
      held = r;
    });
    const blocker = f.db.database.transaction(async (tx) => {
      await lockCreditPrice(tx, input.modelId, input.resolution);
      held();
      await new Promise<void>((r) => {
        release = r;
      });
      await tx.modelCreditPrice.update({
        where: { modelId_resolution: { modelId: input.modelId, resolution: input.resolution } },
        data: { unitCredits: 250, version: { increment: 1 } },
      });
    });
    await locked;
    const pending = catalog.quote(userId, input);
    release();
    await blocker;
    expect(await pending).toMatchObject({ unitCredits: 250, totalCredits: 500 });
  });
  it('prices reviewed ratios and remix identically and multiplies counts 1 through 4 exactly', async () => {
    const asset = await f.db.database.client.asset.create({
      data: {
        userId,
        name: 'offline reference',
        objectKey: `test/${randomUUID()}`,
        width: 1024,
        height: 1024,
        byteSize: 100,
        contentType: 'image/png',
        sha256: 'test',
      },
    });
    for (const [count, totalCredits] of [
      [1, 250],
      [2, 500],
      [3, 750],
      [4, 1000],
    ]) {
      expect(await catalog.quote(userId, { ...input, count, ratio: '16:9' })).toMatchObject({
        unitCredits: 250,
        totalCredits,
      });
      expect(
        await catalog.quote(userId, {
          ...input,
          source: 'remix',
          referenceAssetId: asset.id,
          count,
        }),
      ).toMatchObject({ unitCredits: 250, totalCredits });
    }
    const quote = await catalog.quote(userId, input);
    const current = await f.db.database.client.modelCreditPrice.findFirstOrThrow({
      where: { modelId: input.modelId },
    });
    await save(250, true, current.version);
    expect(
      (await jobs.create(userId, { quoteId: quote.id, input }, randomUUID(), 'create'))
        .estimatedCredits,
    ).toBe(500);
  });
});
