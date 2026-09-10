import { describe, expect, it } from 'vitest';
import {
  OFFICIAL_MODELS,
  OFFICIAL_PROTOCOLS,
  officialSpecs,
  getOfficialOutputSpec,
} from '../src/modules/providers/official-models.js';
import { loadOfficialConfig, officialSnapshot } from '../src/modules/providers/official-config.js';
import { actualCost } from '../src/modules/providers/pricing.js';
import { normalizeInput } from '../src/modules/catalog/input-schema.js';

export const fixtureConfig = () => ({
  revision: 'offline-v1',
  accounts: {
    openai: {
      scope: 'test-openai',
      credentialVersion: 'v1',
      concurrency: 1,
      maxUnknown: 1,
      dailyBudgetMicros: '10000000',
    },
  },
  models: [
    {
      modelId: 'gpt-image-2',
      sales: { '1K': 100, '2K': 200, '4K': 400 },
      reserveCostMicros: '1000000',
      pricing: {
        version: 'test-not-real-prices',
        currency: 'USD',
        rates: {
          input_text_tokens: '5000000',
          input_image_tokens: '10000000',
          output_image_tokens: '30000000',
          output_text_tokens: '5000000',
        },
      },
    },
  ],
});

describe('official model specifications and fail-closed configuration', () => {
  it('contains five distinct exact IDs, and published model-specific dimensions', () => {
    expect(OFFICIAL_MODELS.map((m) => m.id)).toHaveLength(5);
    expect(
      officialSpecs('gemini-3.1-flash-image').find(
        (s) => s.resolution === '2K' && s.ratio === '16:9',
      ),
    ).toMatchObject({ width: 2752, height: 1536 });
    expect(officialSpecs('gemini-2.5-flash-image').find((s) => s.ratio === '16:9')).toMatchObject({
      width: 1344,
      height: 768,
    });
    expect(officialSpecs('gemini-3.1-flash-lite-image')).toHaveLength(1);
    expect(officialSpecs('gemini-3.1-flash-lite-image')[0]).toMatchObject({
      resolution: '1K',
      ratio: '1:1',
      width: 1024,
      height: 1024,
    });
    expect(officialSpecs('gemini-3.1-flash-lite-image')[0]!.imageSize).toBeUndefined();
    expect(
      officialSpecs('gpt-image-2').some((s) => s.resolution === '4K' && s.ratio === '1:1'),
    ).toBe(false);
    for (const spec of officialSpecs('gpt-image-2')) {
      expect(spec.width % 16).toBe(0);
      expect(spec.height % 16).toBe(0);
      expect(spec.width * spec.height).toBeGreaterThanOrEqual(655360);
      expect(spec.width * spec.height).toBeLessThanOrEqual(8294400);
      expect(Math.max(spec.width, spec.height)).toBeLessThanOrEqual(3840);
    }
    expect(getOfficialOutputSpec('gpt-image-2', 'arbitrary')).toBeUndefined();
  });
  it('accepts resolution × ratio only when the model has that reviewed combination', () => {
    expect(
      normalizeInput({
        modelId: 'gemini-3.1-flash-image',
        resolution: '2K',
        ratio: '16:9',
        prompt: 'cup',
        count: 1,
      }),
    ).toMatchObject({ ratio: '16:9' });
    for (const input of [
      { modelId: 'gemini-3.1-flash-image', resolution: '0.5K', ratio: '21:9' },
      { modelId: 'gpt-image-2', resolution: '4K', ratio: '1:1' },
      { modelId: 'gemini-2.5-flash-image', resolution: '2K', ratio: '1:1' },
      { modelId: 'gemini-3.1-flash-lite-image', resolution: '1K', ratio: '16:9' },
      { modelId: 'simulation-image-v1', resolution: '1K', ratio: '16:9' },
    ])
      expect(() => normalizeInput({ ...input, prompt: 'cup', count: 1 })).toThrow();
  });
  it('defaults to no official channels and requires explicit prices and credentials', () => {
    expect(loadOfficialConfig({}).models).toEqual([]);
    expect(() =>
      loadOfficialConfig({ OFFICIAL_IMAGE_MODELS_JSON: JSON.stringify(fixtureConfig()) }),
    ).toThrow(/credential/i);
    const invalid = fixtureConfig();
    invalid.models[0]!.pricing.rates.output_image_tokens = '-1';
    expect(() =>
      loadOfficialConfig({
        OFFICIAL_IMAGE_MODELS_JSON: JSON.stringify(invalid),
        OPENAI_API_KEY: 'offline-key',
      }),
    ).toThrow(/configuration/i);
  });
  it('snapshots prices and official pixels without secrets or user-controlled endpoints', () => {
    const config = loadOfficialConfig({
      OFFICIAL_IMAGE_MODELS_JSON: JSON.stringify(fixtureConfig()),
      OPENAI_API_KEY: 'offline-key',
    });
    const snapshot = officialSnapshot(config, 'gpt-image-2', '4K', '16:9')!;
    expect(snapshot).toMatchObject({
      upstreamModelId: 'gpt-image-2',
      width: 3840,
      height: 2160,
      pricing: { version: 'test-not-real-prices' },
    });
    expect(JSON.stringify(snapshot)).not.toContain('offline-key');
    expect(snapshot).not.toHaveProperty('unitCredits');
    expect(officialSnapshot(config, 'gpt-image-2', '4K', '1:1')).toBeUndefined();
  });
  it('sales values cannot change execution identity; explicit runtime resolutions need no sales', () => {
    const settings = fixtureConfig();
    const load = () =>
      loadOfficialConfig({
        OFFICIAL_IMAGE_MODELS_JSON: JSON.stringify(settings),
        OPENAI_API_KEY: 'offline-key',
      });
    const first = officialSnapshot(load(), 'gpt-image-2', '1K', '1:1')!;
    settings.models[0]!.sales['1K'] = 200;
    expect(officialSnapshot(load(), 'gpt-image-2', '1K', '1:1')).toEqual(first);
    settings.accounts.openai.credentialVersion = 'v2';
    expect(officialSnapshot(load(), 'gpt-image-2', '1K', '1:1')!.channelId).not.toBe(
      first.channelId,
    );
    const explicit = {
      ...settings,
      models: [{ ...settings.models[0], sales: undefined, enabledResolutions: ['1K'] }],
    };
    const configured = loadOfficialConfig({
      OFFICIAL_IMAGE_MODELS_JSON: JSON.stringify(explicit),
      OPENAI_API_KEY: 'offline-key',
    });
    expect(officialSnapshot(configured, 'gpt-image-2', '1K', '1:1')).toBeDefined();
    expect(officialSnapshot(configured, 'gpt-image-2', '2K', '1:1')).toBeUndefined();
  });
  it('includes protocol in execution snapshots and keeps output and cost changes in identity', () => {
    const settings = fixtureConfig();
    const load = () =>
      loadOfficialConfig({
        OFFICIAL_IMAGE_MODELS_JSON: JSON.stringify(settings),
        OPENAI_API_KEY: 'offline-key',
      });
    const original = officialSnapshot(load(), 'gpt-image-2', '1K', '1:1')!;
    expect(original).toMatchObject({ protocol: 'openai-images-v1' });
    const protocols: Record<string, string> = OFFICIAL_PROTOCOLS;
    const protocol = protocols.openai!;
    try {
      protocols.openai = 'future-reviewed-protocol';
      expect(officialSnapshot(load(), 'gpt-image-2', '1K', '1:1')!.channelId).not.toBe(
        original.channelId,
      );
    } finally {
      protocols.openai = protocol;
    }
    expect(officialSnapshot(load(), 'gpt-image-2', '1K', '16:9')!.channelId).not.toBe(
      original.channelId,
    );
    settings.models[0]!.reserveCostMicros = '999999';
    expect(officialSnapshot(load(), 'gpt-image-2', '1K', '1:1')!.channelId).not.toBe(
      original.channelId,
    );
  });
  it('calculates integer USD microcost only with complete accounted usage', () => {
    const pricing = fixtureConfig().models[0]!.pricing;
    const lines = [
      { dimension: 'input_text_tokens', quantity: '10', unit: 'token', source: 'response' },
      { dimension: 'output_image_tokens', quantity: '100', unit: 'token', source: 'response' },
    ] as const;
    expect(actualCost(pricing, [...lines], true)).toBe(3050n);
    expect(actualCost(pricing, [...lines], false)).toBeNull();
    expect(
      actualCost(
        pricing,
        [...lines, { dimension: 'unpriced', quantity: '1', unit: 'token', source: 'response' }],
        true,
      ),
    ).toBeNull();
    expect(actualCost(pricing, [{ ...lines[0], quantity: '1.5' }], true)).toBeNull();
  });
});
