import { describe, expect, it } from 'vitest';
import {
  loadThirdPartyImageConfig,
  thirdPartyImageSnapshot,
} from '../src/modules/providers/third-party-config.js';
import { OPENAI_IMAGES_MODEL_IDS } from '../src/modules/providers/official-models.js';
import { OpenAIImageProvider } from '../src/modules/providers/official/openai.js';
import type { ObjectStore } from '../src/modules/assets/object-store.js';
import type {
  NormalizedImageRequest,
  ProviderContext,
  SubmitResult,
} from '../src/modules/providers/contracts.js';

const secret = 'third-party-image-secret';
const baseEnv = {
  NODE_ENV: 'development',
  SUB2API_ENABLED: 'true',
  SUB2API_BASE_URL: 'http://localhost:8080',
  SUB2API_API_KEY: secret,
  SUB2API_MODEL_ID: 'gpt-5.6',
  SUB2API_DAILY_BUDGET_MICROS: '10000000',
  SUB2API_IMAGE_MODELS_JSON: JSON.stringify({
    revision: 'sub2api-image-v1',
    models: [
      {
        modelId: 'gpt-image-2',
        enabledResolutions: ['1K', '2K', '4K'],
        reserveCostMicros: '1000000',
        pricing: {
          version: 'sub2api-cost-v1',
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
  }),
};

function request(): NormalizedImageRequest {
  return {
    jobId: 'job-1',
    itemId: 'item-1',
    attemptId: 'attempt-1',
    productModelVersionId: 'gpt-image-2',
    upstreamModelId: 'gpt-image-2',
    outputSpecId: 'png-1k-1x1-v1',
    prompt: 'A quiet blue house.',
    promptTemplateVersion: 'prompt-v1',
    images: [],
    output: {
      width: 1024,
      height: 1024,
      format: 'png',
      quality: 'medium',
      allowedNativeDimensions: [{ width: 1024, height: 1024 }],
    },
    count: 1,
    executionMode: 'interactive',
    businessDeadlineAt: '2026-09-12T12:00:00.000Z',
  };
}

function context(): ProviderContext {
  return {
    channelId: 'third-party-sub2api-gpt-image-2',
    credentialVersionRef: 'v1',
    baseUrl: 'http://localhost:8080/v1',
    region: 'global',
    capabilityVersionId: 'sub2api-image-v1',
    requestKey: 'attempt-1',
    connectTimeoutMs: 500,
    responseTimeoutMs: 2_000,
    signal: new AbortController().signal,
  };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

class EmptyStore implements ObjectStore {
  async put() {}
  async get(): Promise<Uint8Array> {
    throw new Error('not used');
  }
  async delete() {}
}

describe('Sub2API third-party image channel', () => {
  it('loads an OpenAI-compatible image model and snapshots reviewed output specs', () => {
    const config = loadThirdPartyImageConfig(baseEnv);
    expect(config).toMatchObject({
      baseUrl: 'http://localhost:8080/v1',
      revision: 'sub2api-image-v1',
      models: [{ modelId: 'gpt-image-2', enabledResolutions: ['1K', '2K', '4K'] }],
    });
    const snapshot = thirdPartyImageSnapshot(config, 'gpt-image-2', '2K', '16:9');
    expect(snapshot).toMatchObject({
      provider: 'openai',
      protocol: 'openai-images-third-party-v1',
      upstreamModelId: 'gpt-image-2',
      width: 2048,
      height: 1152,
      reserveCostMicros: '1000000',
    });
    expect(JSON.stringify(snapshot)).not.toContain(secret);
  });

  it('rejects a Nano Banana model in an OpenAI Images-only third-party config', () => {
    const invalid = JSON.parse(baseEnv.SUB2API_IMAGE_MODELS_JSON);
    invalid.models[0].modelId = 'gemini-3.1-flash-image';
    expect(() =>
      loadThirdPartyImageConfig({
        ...baseEnv,
        SUB2API_IMAGE_MODELS_JSON: JSON.stringify(invalid),
      }),
    ).toThrow(/SUB2API_IMAGE_MODELS_JSON/i);
  });

  it('accepts every OpenAI Images model and still refuses a Google-protocol model', () => {
    const config = loadThirdPartyImageConfig({
      ...baseEnv,
      SUB2API_IMAGE_MODELS_JSON: JSON.stringify({
        revision: 'sub2api-image-v2',
        models: OPENAI_IMAGES_MODEL_IDS.map((modelId) => ({
          modelId,
          enabledResolutions: ['1K', '2K'],
          reserveCostMicros: '1000000',
          pricing: {
            version: 'sub2api-cost-v1',
            currency: 'USD',
            rates: {
              input_text_tokens: '5000000',
              input_image_tokens: '10000000',
              output_image_tokens: '30000000',
              output_text_tokens: '5000000',
            },
          },
        })),
      }),
    })!;
    expect(config.models.map((model) => model.modelId)).toEqual([...OPENAI_IMAGES_MODEL_IDS]);
    expect(thirdPartyImageSnapshot(config, 'gpt-image-2.5-sunburst', '2K', '16:9')).toMatchObject({
      provider: 'openai',
      protocol: 'openai-images-third-party-v1',
      upstreamModelId: 'gpt-image-2.5-sunburst',
      width: 2048,
      height: 1152,
      reserveCostMicros: '1000000',
    });
    // Refusal is about the protocol the model needs, not about the channel it was asked for.
    expect(thirdPartyImageSnapshot(config, 'gemini-3.1-flash-image', '1K', '1:1')).toBeUndefined();
    const forged = JSON.parse(baseEnv.SUB2API_IMAGE_MODELS_JSON);
    forged.models[0].modelId = 'gemini-3.1-flash-image';
    expect(() =>
      loadThirdPartyImageConfig({
        ...baseEnv,
        SUB2API_IMAGE_MODELS_JSON: JSON.stringify(forged),
      }),
    ).toThrow(/SUB2API_IMAGE_MODELS_JSON/i);
  });

  it('keeps the runtime gate closed even if a Google-protocol model reaches the config object', () => {
    const config = loadThirdPartyImageConfig(baseEnv)!;
    // Shape-bypass on purpose: the schema is the first gate, this asserts the second one.
    const forged = {
      ...config,
      models: [...config.models, { ...config.models[0]!, modelId: 'gemini-3.1-flash-image' }],
    };
    expect(thirdPartyImageSnapshot(forged, 'gemini-3.1-flash-image', '1K', '1:1')).toBeUndefined();
  });

  it('maps GPT Image 2 generation to the configured Sub2API base URL without a live call', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
      calls.push({ url: String(input), init });
      return jsonResponse({
        data: [
          {
            b64_json:
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
          },
        ],
        output_format: 'png',
        quality: 'medium',
        size: '1024x1024',
      });
    }) as typeof fetch;
    const provider = new OpenAIImageProvider(new EmptyStore(), secret, fetcher, {
      baseUrl: 'http://localhost:8080/v1',
      protocol: 'openai-images-third-party-v1',
    });
    const result = await provider.submit(request(), context());
    expect(result).toMatchObject({ kind: 'rejected', failure: { code: 'invalid_output' } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://localhost:8080/v1/images/generations');
    expect(new Headers(calls[0]?.init.headers).get('authorization')).toBe(`Bearer ${secret}`);
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      model: 'gpt-image-2',
      size: '1024x1024',
      quality: 'medium',
    });
  });
});
