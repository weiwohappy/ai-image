import { describe, expect, it } from 'vitest';
import { CatalogService } from '../src/modules/catalog/catalog.service.js';
import { normalizeInput } from '../src/modules/catalog/input-schema.js';
import { buildProviderRegistry } from '../src/modules/providers/official-runtime.js';
import { loadThirdPartyImageConfig } from '../src/modules/providers/third-party-config.js';
import type { ObjectStore } from '../src/modules/assets/object-store.js';

const imageEnv = {
  NODE_ENV: 'development',
  SUB2API_ENABLED: 'true',
  SUB2API_BASE_URL: 'http://localhost:8080',
  SUB2API_API_KEY: 'do-not-print',
  SUB2API_MODEL_ID: 'gpt-5.6',
  SUB2API_DAILY_BUDGET_MICROS: '10000000',
  SUB2API_IMAGE_MODELS_JSON: JSON.stringify({
    revision: 'runtime-v1',
    models: [
      {
        modelId: 'gpt-image-2',
        enabledResolutions: ['1K'],
        reserveCostMicros: '1000000',
        pricing: {
          version: 'runtime-cost-v1',
          currency: 'USD',
          rates: {
            input_text_tokens: '1',
            input_image_tokens: '1',
            output_image_tokens: '1',
          },
        },
      },
    ],
  }),
};

class EmptyStore implements ObjectStore {
  async put() {}
  async get(): Promise<Uint8Array> {
    throw new Error('not used');
  }
  async delete() {}
}

function config() {
  return {
    nodeEnv: 'development',
    simulationProviderEnabled: false,
    thirdPartyImages: loadThirdPartyImageConfig(imageEnv),
  } as never;
}

describe('Sub2API image runtime integration', () => {
  it('registers one channel per configured GPT Image 2 output preset', () => {
    const registry = buildProviderRegistry(config(), new EmptyStore(), viFetch());
    expect(registry.channels).toHaveLength(10);
    const square = registry.channels.find(
      (channel) => channel.profile.outputSpecId === 'png-1k-1x1-v1',
    );
    expect(square?.profile).toMatchObject({
      productVersion: 'gpt-image-2',
      upstreamModelId: 'gpt-image-2',
      outputSpecId: 'png-1k-1x1-v1',
      width: 1024,
      height: 1024,
      baseUrl: 'http://localhost:8080/v1',
      quotaScope: 'third-party-sub2api-sub2api-default',
    });
    expect(square?.adapter.protocol).toBe('openai-images-third-party-v1');
  });

  it('exposes a third-party model through the normal catalog and quote snapshot path', async () => {
    const service = new CatalogService(
      {
        client: {
          modelCreditPrice: {
            findMany: async () => [
              { modelId: 'gpt-image-2', resolution: '1K', unitCredits: 88, enabled: true },
            ],
          },
        },
      } as never,
      config(),
    );
    await expect(service.models()).resolves.toEqual([
      expect.objectContaining({
        id: 'gpt-image-2',
        resolutions: ['1K'],
        ratios: expect.arrayContaining(['1:1']),
        unitCredits: 88,
      }),
    ]);
    expect(
      service.execution(
        normalizeInput({
          modelId: 'gpt-image-2',
          resolution: '1K',
          ratio: '1:1',
          prompt: 'blue house',
          count: 1,
        }),
      ),
    ).toMatchObject({
      protocol: 'openai-images-third-party-v1',
      channelId: expect.stringContaining('third-party-sub2api'),
    });
  });
});

function viFetch() {
  return (async () => new Response('{}', { status: 200 })) as typeof fetch;
}
