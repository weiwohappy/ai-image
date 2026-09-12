import { describe, expect, it, vi } from 'vitest';
import {
  loadThirdPartyConfig,
  redactThirdPartyConfig,
} from '../src/modules/providers/third-party-config.js';
import { loadConfig } from '../src/config.js';
import { AdminProviderVerificationService } from '../src/modules/admin/provider-verification.service.js';
import { AdminQueryService } from '../src/modules/admin/query.service.js';
import { OpenAICompatibleChatClient } from '../src/modules/providers/third-party/openai-compatible.js';

const secret = 'provider-test-secret';

describe('third-party OpenAI-compatible provider configuration', () => {
  it('loads the configured third-party channel into AppConfig', () => {
    const config = loadConfig({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://viviai@127.0.0.1:55432/viviai_dev',
      REDIS_URL: 'redis://127.0.0.1:56379',
      SIMULATION_PROVIDER_ENABLED: 'false',
      DEV_MAIL_ENABLED: 'false',
      SUB2API_ENABLED: 'true',
      SUB2API_BASE_URL: 'http://localhost:8080',
      SUB2API_API_KEY: secret,
      SUB2API_MODEL_ID: 'gpt-5.1',
      SUB2API_DAILY_BUDGET_MICROS: '10000000',
      SUB2API_IMAGE_MODELS_JSON: JSON.stringify({
        revision: 'sub2api-images-v1',
        models: [
          {
            modelId: 'gpt-image-2',
            enabledResolutions: ['1K'],
            reserveCostMicros: '1000000',
            pricing: {
              version: 'provider-cost-v1',
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
    });

    expect(config.thirdPartyChat).toMatchObject({
      id: 'sub2api',
      kind: 'third_party',
      baseUrl: 'http://localhost:8080/v1',
      modelId: 'gpt-5.1',
    });
    expect(config.thirdPartyImages).toMatchObject({
      revision: 'sub2api-images-v1',
      models: [{ modelId: 'gpt-image-2', enabledResolutions: ['1K'] }],
    });
  });

  it('loads Sub2API as a standard third-party channel without exposing the key', () => {
    const config = loadThirdPartyConfig({
      SUB2API_ENABLED: 'true',
      SUB2API_BASE_URL: 'http://localhost:8080',
      SUB2API_API_KEY: secret,
      SUB2API_MODEL_ID: 'gpt-5.1',
      SUB2API_SCOPE: 'sub2api-production',
      SUB2API_CREDENTIAL_VERSION: 'v1',
    })!;

    expect(config).toMatchObject({
      id: 'sub2api',
      kind: 'third_party',
      baseUrl: 'http://localhost:8080/v1',
      modelId: 'gpt-5.1',
      scope: 'sub2api-production',
      credentialVersion: 'v1',
    });
    expect(JSON.stringify(redactThirdPartyConfig(config))).not.toContain(secret);
    expect(config.apiKey).toBe(secret);
  });

  it('loads optional provider capacity and budget settings', () => {
    const config = loadThirdPartyConfig({
      SUB2API_ENABLED: 'true',
      SUB2API_BASE_URL: 'http://localhost:8080',
      SUB2API_API_KEY: 'provider-test-capacity-secret',
      SUB2API_MODEL_ID: 'gpt-5.6',
      SUB2API_CONCURRENCY: '3',
      SUB2API_MAX_UNKNOWN: '2',
      SUB2API_DAILY_BUDGET_MICROS: '123456',
    });
    expect(config).toMatchObject({ concurrency: 3, maxUnknown: 2, dailyBudgetMicros: '123456' });
  });

  it('fails closed for an enabled provider without a key or model', () => {
    expect(() =>
      loadThirdPartyConfig({
        SUB2API_ENABLED: 'true',
        SUB2API_BASE_URL: 'http://localhost:8080',
      }),
    ).toThrow(/SUB2API_API_KEY/i);
  });

  it('does not require a third-party key when the provider is disabled', () => {
    expect(loadThirdPartyConfig({})).toBeUndefined();
  });
});

describe('OpenAI-compatible provider verification', () => {
  it('projects a configured Sub2API account as a third-party provider account', async () => {
    const service = new AdminQueryService(
      {
        client: {
          providerQuota: { findMany: vi.fn().mockResolvedValue([]) },
          providerBudget: { findMany: vi.fn().mockResolvedValue([]) },
        },
      } as never,
      {
        thirdPartyChat: {
          id: 'sub2api',
          kind: 'third_party',
          baseUrl: 'http://localhost:8080/v1',
          apiKey: secret,
          modelId: 'gpt-5.1',
          scope: 'sub2api-default',
          credentialVersion: 'v1',
          concurrency: 1,
          maxUnknown: 1,
          dailyBudgetMicros: '0',
        },
      } as never,
    );
    const result = await service.providers(
      {
        id: 'test',
        email: 'test@example.test',
        displayName: 'Test',
        roles: ['owner'],
        permissions: ['providers.read'],
        sessionExpiresAt: new Date().toISOString(),
      },
      {},
    );
    expect(result.rows).toContainEqual(
      expect.objectContaining({ provider: 'sub2api', simulated: false }),
    );
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('exposes the third-party verification result without returning credentials', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) =>
      String(input).endsWith('/models')
        ? new Response(JSON.stringify({ data: [{ id: 'gpt-5.1' }] }), { status: 200 })
        : new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), {
            status: 200,
          }),
    );
    const previous = globalThis.fetch;
    globalThis.fetch = fetcher;
    try {
      const result = await new AdminProviderVerificationService({
        thirdPartyChat: {
          id: 'sub2api',
          kind: 'third_party',
          baseUrl: 'http://localhost:8080/v1',
          apiKey: secret,
          modelId: 'gpt-5.1',
          scope: 'sub2api-default',
          credentialVersion: 'v1',
          concurrency: 1,
          maxUnknown: 1,
          dailyBudgetMicros: '0',
        },
      } as never).verify({ permissions: ['providers.read'] }, 'sub2api');
      expect(result).toEqual({
        provider: 'sub2api',
        configured: true,
        ok: true,
        modelId: 'gpt-5.1',
        modelListed: true,
        responseReceived: true,
      });
      expect(JSON.stringify(result)).not.toContain(secret);
    } finally {
      globalThis.fetch = previous;
    }
  });

  it('verifies configured third-party image models by listing them without generating an image', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      expect(String(input)).toBe('http://localhost:8080/v1/models');
      return new Response(JSON.stringify({ data: [{ id: 'gpt-image-2' }] }), { status: 200 });
    });
    const previous = globalThis.fetch;
    globalThis.fetch = fetcher;
    try {
      const result = await new AdminProviderVerificationService({
        thirdPartyImages: {
          id: 'sub2api',
          kind: 'third_party',
          baseUrl: 'http://localhost:8080/v1',
          apiKey: secret,
          scope: 'sub2api-default',
          credentialVersion: 'v1',
          concurrency: 1,
          maxUnknown: 1,
          dailyBudgetMicros: '0',
          revision: 'image-v1',
          models: [
            {
              modelId: 'gpt-image-2',
              enabledResolutions: ['1K'],
              reserveCostMicros: '1000000',
              pricing: {
                version: 'cost-v1',
                currency: 'USD',
                rates: {
                  input_text_tokens: '1',
                  input_image_tokens: '1',
                  output_image_tokens: '1',
                },
              },
            },
          ],
        },
      } as never).verifyImages({ permissions: ['providers.read'] }, 'sub2api');
      expect(result).toEqual({
        provider: 'sub2api',
        configured: true,
        ok: true,
        modelIds: ['gpt-image-2'],
        modelListed: true,
        responseReceived: true,
        generationProbe: 'not_run',
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result)).not.toContain(secret);
    } finally {
      globalThis.fetch = previous;
    }
  });

  it('checks the configured model through /models and makes a bounded probe request', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/models')) {
        expect(init?.headers).toMatchObject({ authorization: `Bearer ${secret}` });
        return new Response(JSON.stringify({ data: [{ id: 'gpt-5.1' }] }), { status: 200 });
      }
      expect(url).toBe('http://localhost:8080/v1/chat/completions');
      expect(init?.headers).toMatchObject({ authorization: `Bearer ${secret}` });
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: 'gpt-5.1',
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        max_tokens: 8,
        stream: false,
      });
      return new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] }),
        { status: 200 },
      );
    });

    const result = await new OpenAICompatibleChatClient(
      { baseUrl: 'http://localhost:8080/v1', apiKey: secret, modelId: 'gpt-5.1' },
      fetcher,
    ).verify();

    expect(result).toEqual({
      ok: true,
      modelId: 'gpt-5.1',
      modelListed: true,
      responseReceived: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('returns safe diagnostics for auth failures without leaking the key or body', async () => {
    const result = await new OpenAICompatibleChatClient(
      { baseUrl: 'http://localhost:8080/v1', apiKey: secret, modelId: 'gpt-5.1' },
      vi.fn<typeof fetch>(async () => new Response('secret upstream body', { status: 401 })),
    ).verify();

    expect(result).toEqual({
      ok: false,
      code: 'auth',
      message: 'Provider authentication failed',
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain('secret upstream body');
  });
});
