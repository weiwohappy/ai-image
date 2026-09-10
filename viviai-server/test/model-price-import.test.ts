import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './helpers/database.js';
import {
  importLegacyPrices,
  parseLegacyPrices,
} from '../src/modules/admin/model-pricing/import.js';
let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db?.cleanup();
});
const raw = JSON.stringify({
  models: [{ modelId: 'gpt-image-2', sales: { '1K': 123, '2K': 456 } }],
  credentials: 'must-not-appear',
});
it('parses reviewed legacy sales without requiring keys, rejecting invalid prices and unsupported tuples', () => {
  expect(parseLegacyPrices(raw)).toEqual([
    { modelId: 'gpt-image-2', resolution: '1K', unitCredits: 123 },
    { modelId: 'gpt-image-2', resolution: '2K', unitCredits: 456 },
  ]);
  expect(parseLegacyPrices('')).toEqual([]);
  for (const value of [0, -1, 1.5, 1000001, '100'])
    expect(() =>
      parseLegacyPrices(
        JSON.stringify({ models: [{ modelId: 'gpt-image-2', sales: { '1K': value } }] }),
      ),
    ).toThrow();
  expect(() =>
    parseLegacyPrices(
      JSON.stringify({ models: [{ modelId: 'gemini-2.5-flash-image', sales: { '4K': 100 } }] }),
    ),
  ).toThrow();
});
it('defaults to read-only dry-run and apply only creates missing rows with immutable offline audits', async () => {
  const config = { nodeEnv: 'development', host: '127.0.0.1', databaseUrl: db.url };
  const dry = await importLegacyPrices(db.database, config, raw);
  expect(dry).toMatchObject({
    apply: false,
    items: [{ outcome: 'would_create' }, { outcome: 'would_create' }],
  });
  expect(await db.database.client.modelCreditPrice.count()).toBe(0);
  expect(JSON.stringify(dry)).not.toContain('must-not-appear');
  await importLegacyPrices(db.database, config, raw, true);
  await db.database.client.modelCreditPrice.update({
    where: { modelId_resolution: { modelId: 'gpt-image-2', resolution: '1K' } },
    data: { unitCredits: 999, enabled: false },
  });
  const replay = await importLegacyPrices(db.database, config, raw, true);
  expect(replay.items.every((r) => r.outcome === 'exists')).toBe(true);
  expect(
    await db.database.client.modelCreditPrice.findFirst({ where: { resolution: '1K' } }),
  ).toMatchObject({ enabled: false, unitCredits: 999 });
  const audits = await db.database.client.adminAuditEvent.findMany();
  expect(audits).toHaveLength(2);
  expect(audits[0]).toMatchObject({
    accountId: null,
    action: 'model-pricing.import',
    metadata: { source: 'offline_import', beforeUnitCredits: null, afterVersion: 1 },
  });
  await expect(
    importLegacyPrices(db.database, { ...config, nodeEnv: 'production' }, raw, true),
  ).rejects.toThrow();
  await expect(
    importLegacyPrices(
      db.database,
      { ...config, databaseUrl: 'postgresql://user@remote.example/db' },
      raw,
      true,
    ),
  ).rejects.toThrow();
});
