import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ObjectStore } from '../src/modules/assets/object-store.js';
import type {
  NormalizedImageRequest,
  ProviderContext,
  SubmitResult,
} from '../src/modules/providers/contracts.js';
import { GoogleImageProvider } from '../src/modules/providers/official/google.js';
import { OpenAIImageProvider } from '../src/modules/providers/official/openai.js';

let squarePng: Buffer;
let widePng: Buffer;
let referencePng: Buffer;
let subjectPng: Buffer;

beforeAll(async () => {
  [squarePng, widePng, referencePng, subjectPng] = await Promise.all([
    png(1024, 1024, '#134e4a'),
    png(2752, 1536, '#1d4ed8'),
    png(20, 12, '#be123c'),
    png(12, 20, '#ca8a04'),
  ]);
});

class PrivateStore implements ObjectStore {
  constructor(private readonly objects = new Map<string, Uint8Array>()) {}
  async put(key: string, bytes: Uint8Array) {
    this.objects.set(key, bytes);
  }
  async get(key: string) {
    const bytes = this.objects.get(key);
    if (!bytes) throw new Error(`private object unavailable: ${key}`);
    return bytes;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

function png(width: number, height: number, background: string) {
  return sharp({ create: { width, height, channels: 3, background } })
    .png()
    .toBuffer();
}

function digest(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}

function context(
  signal = new AbortController().signal,
  responseTimeoutMs = 2_000,
): ProviderContext {
  return {
    channelId: 'official-channel',
    credentialVersionRef: 'credential-v7',
    baseUrl: 'https://attacker.invalid',
    region: 'local',
    capabilityVersionId: 'official-capability-v1',
    requestKey: 'attempt-1',
    connectTimeoutMs: 500,
    responseTimeoutMs,
    signal,
  };
}

function request(
  upstreamModelId: string,
  overrides: Partial<NormalizedImageRequest> = {},
): NormalizedImageRequest {
  return {
    jobId: 'job-1',
    itemId: 'item-1',
    attemptId: 'attempt-1',
    productModelVersionId: `product-${upstreamModelId}`,
    upstreamModelId,
    outputSpecId: 'png-1k-1x1-v1',
    prompt: 'Paint a quiet blue house.',
    promptTemplateVersion: 'prompt-v1',
    images: [],
    output: {
      width: 1024,
      height: 1024,
      format: 'png',
      ...(upstreamModelId.startsWith('gpt-image-') ? { quality: 'medium' as const } : {}),
      allowedNativeDimensions: [{ width: 1024, height: 1024 }],
    },
    count: 1,
    executionMode: 'interactive',
    businessDeadlineAt: '2026-09-09T12:00:00.000Z',
    ...overrides,
  };
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers: ConstructorParameters<typeof Headers>[0] = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...Object.fromEntries(new Headers(headers)) },
  });
}

function googleSuccess(bytes: Uint8Array, overrides: Record<string, unknown> = {}) {
  return {
    id: 'google-interaction-7',
    object: 'interaction',
    status: 'completed',
    steps: [
      {
        type: 'model_output',
        content: [
          { type: 'image', data: Buffer.from(bytes).toString('base64'), mime_type: 'image/png' },
        ],
      },
    ],
    usage: {
      input_tokens_by_modality: [
        { modality: 'text', tokens: 11 },
        { modality: 'image', tokens: 0 },
      ],
      output_tokens_by_modality: [
        { modality: 'text', tokens: 0 },
        { modality: 'image', tokens: 256 },
      ],
      total_cached_tokens: 0,
      total_input_tokens: 11,
      total_output_tokens: 256,
      total_thought_tokens: 3,
      total_tool_use_tokens: 0,
      total_tokens: 270,
    },
    ...overrides,
  };
}

function openaiSuccess(
  bytes: Uint8Array,
  usage: unknown = {
    input_tokens: 12,
    input_tokens_details: { text_tokens: 12, image_tokens: 0 },
    output_tokens: 100,
    total_tokens: 112,
  },
) {
  return {
    created: 1,
    background: 'opaque',
    data: [{ b64_json: Buffer.from(bytes).toString('base64') }],
    output_format: 'png',
    quality: 'medium',
    size: '1024x1024',
    usage,
  };
}

function fakeFetch(
  implementation: (url: string, init: RequestInit) => Response | Promise<Response>,
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return implementation(url, init);
  }) as typeof fetch;
  return { fetcher, calls };
}

async function outputBytes(result: SubmitResult) {
  expect(result.kind).toBe('completed');
  if (result.kind !== 'completed') throw new Error('expected completed result');
  expect(result.outputs).toHaveLength(1);
  const output = result.outputs[0];
  expect(output?.kind).toBe('stream');
  if (!output || output.kind !== 'stream') throw new Error('expected stream output');
  const chunks: Uint8Array[] = [];
  for await (const chunk of output.content) chunks.push(chunk);
  return { result, output, bytes: Buffer.concat(chunks) };
}

describe('Google Interactions REST adapter', () => {
  it.each([
    ['gemini-2.5-flash-image', undefined],
    ['gemini-3.1-flash-lite-image', undefined],
    ['gemini-3.1-flash-image', '1K'],
    ['gemini-3-pro-image', '1K'],
  ])('maps the reviewed square preset for %s', async (model, imageSize) => {
    const http = fakeFetch((_url, init) => {
      expect(init.method).toBe('POST');
      expect(init.redirect).toBe('error');
      expect(new Headers(init.headers).get('x-goog-api-key')).toBe('google-secret');
      expect(new Headers(init.headers).get('authorization')).toBeNull();
      const body = JSON.parse(String(init.body));
      expect(body).toEqual({
        model,
        input: 'Paint a quiet blue house.',
        response_format: {
          type: 'image',
          aspect_ratio: '1:1',
          ...(imageSize === undefined ? {} : { image_size: imageSize }),
          delivery: 'inline',
        },
        store: false,
      });
      expect(body.tools).toBeUndefined();
      return jsonResponse(googleSuccess(squarePng));
    });
    const provider = new GoogleImageProvider(new PrivateStore(), 'google-secret', http.fetcher);

    const completed = await outputBytes(await provider.submit(request(model), context()));

    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/interactions',
    );
    expect(completed.bytes).toEqual(squarePng);
    expect(completed.output.mimeType).toBe('image/png');
    expect(completed.result.ref).toEqual({
      providerRequestId: 'google-interaction-7',
      channelId: 'official-channel',
      credentialVersionRef: 'credential-v7',
    });
    expect(completed.result.usage).toEqual([
      { dimension: 'input_text_tokens', quantity: '11', unit: 'token', source: 'response' },
      { dimension: 'input_image_tokens', quantity: '0', unit: 'token', source: 'response' },
      { dimension: 'output_text_tokens', quantity: '0', unit: 'token', source: 'response' },
      { dimension: 'output_image_tokens', quantity: '256', unit: 'token', source: 'response' },
      { dimension: 'thought_tokens', quantity: '3', unit: 'token', source: 'response' },
    ]);
    expect(completed.result.usageComplete).toBe(true);
  });

  it('maps a documented non-square 2K preset without resizing the returned image', async () => {
    const http = fakeFetch((_url, init) => {
      const body = JSON.parse(String(init.body));
      expect(body.response_format).toEqual({
        type: 'image',
        aspect_ratio: '16:9',
        image_size: '2K',
        delivery: 'inline',
      });
      return jsonResponse(googleSuccess(widePng));
    });
    const provider = new GoogleImageProvider(new PrivateStore(), 'key', http.fetcher);
    const wide = request('gemini-3.1-flash-image', {
      outputSpecId: 'png-2k-16x9-v1',
      output: {
        width: 2752,
        height: 1536,
        format: 'png',
        allowedNativeDimensions: [{ width: 2752, height: 1536 }],
      },
    });

    const completed = await outputBytes(await provider.submit(wide, context()));

    expect(await sharp(completed.bytes).metadata()).toMatchObject({ width: 2752, height: 1536 });
    expect(http.calls).toHaveLength(1);
  });

  it('rejects an upstream image whose raster dimensions do not match the reviewed preset', async () => {
    const http = fakeFetch(() => jsonResponse(googleSuccess(squarePng)));
    const provider = new GoogleImageProvider(new PrivateStore(), 'key', http.fetcher);
    const wide = request('gemini-3.1-flash-image', {
      outputSpecId: 'png-2k-16x9-v1',
      output: {
        width: 2752,
        height: 1536,
        format: 'png',
        allowedNativeDimensions: [{ width: 2752, height: 1536 }],
      },
    });

    expect(await provider.submit(wide, context())).toMatchObject({
      kind: 'rejected',
      failure: {
        code: 'invalid_output',
        acceptance: 'accepted',
        billing: 'unknown',
        usageComplete: true,
      },
    });
    expect(http.calls).toHaveLength(1);
  });

  it('accepts an inline JPEG when the declared MIME matches the exact raster', async () => {
    const squareJpeg = await sharp({
      create: { width: 1024, height: 1024, channels: 3, background: '#312e81' },
    })
      .jpeg()
      .toBuffer();
    const body = googleSuccess(squarePng);
    body.steps[0]!.content[0] = {
      type: 'image',
      data: squareJpeg.toString('base64'),
      mime_type: 'image/jpeg',
    };
    const http = fakeFetch(() => jsonResponse(body));
    const provider = new GoogleImageProvider(new PrivateStore(), 'key', http.fetcher);

    const completed = await outputBytes(
      await provider.submit(request('gemini-3.1-flash-image'), context()),
    );

    expect(completed.output.mimeType).toBe('image/jpeg');
    expect(completed.bytes).toEqual(squareJpeg);
  });

  it('sorts private image inputs, labels declared roles/orders, and verifies every digest', async () => {
    const store = new PrivateStore(
      new Map([
        ['private/reference', referencePng],
        ['private/subject', subjectPng],
      ]),
    );
    const http = fakeFetch((_url, init) => {
      const body = JSON.parse(String(init.body));
      expect(body.input).toEqual([
        {
          type: 'text',
          text: 'Paint a quiet blue house.\n\nInput images by declared order:\norder=0 role=reference\norder=1 role=subject',
        },
        { type: 'image', data: referencePng.toString('base64'), mime_type: 'image/png' },
        { type: 'image', data: subjectPng.toString('base64'), mime_type: 'image/png' },
      ]);
      return jsonResponse(googleSuccess(squarePng));
    });
    const provider = new GoogleImageProvider(store, 'key', http.fetcher);
    const withImages = request('gemini-3.1-flash-image', {
      images: [
        {
          assetId: 'subject',
          role: 'subject',
          order: 1,
          sha256: digest(subjectPng),
          mimeType: 'image/png',
          width: 12,
          height: 20,
          objectKey: 'private/subject',
        },
        {
          assetId: 'reference',
          role: 'reference',
          order: 0,
          sha256: digest(referencePng),
          mimeType: 'image/png',
          width: 20,
          height: 12,
          objectKey: 'private/reference',
        },
      ],
    });

    expect((await provider.submit(withImages, context())).kind).toBe('completed');
    expect(http.calls).toHaveLength(1);

    withImages.images[1] = { ...withImages.images[1]!, sha256: '0'.repeat(64) };
    const badDigest = await provider.submit(withImages, context());
    expect(badDigest).toMatchObject({
      kind: 'rejected',
      failure: { code: 'invalid_input', acceptance: 'not_accepted', billing: 'not_billable' },
    });
    expect(http.calls).toHaveLength(1);
  });

  it('rejects a private reference larger than 5 MiB before network I/O', async () => {
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1, 7);
    const store = new PrivateStore(new Map([['private/oversized', oversized]]));
    const http = fakeFetch(() => jsonResponse(googleSuccess(squarePng)));
    const provider = new GoogleImageProvider(store, 'key', http.fetcher);
    const withOversizedReference = request('gemini-3.1-flash-image', {
      images: [
        {
          assetId: 'oversized',
          role: 'reference',
          order: 0,
          sha256: digest(oversized),
          mimeType: 'image/png',
          width: 1,
          height: 1,
          objectKey: 'private/oversized',
        },
      ],
    });

    expect(await provider.submit(withOversizedReference, context())).toMatchObject({
      kind: 'rejected',
      failure: { code: 'invalid_input', acceptance: 'not_accepted', billing: 'not_billable' },
    });
    expect(http.calls).toHaveLength(0);
  });

  it('rejects unreviewed output combinations and Lite multi-image input before network I/O', async () => {
    const http = fakeFetch(() => jsonResponse(googleSuccess(squarePng)));
    const provider = new GoogleImageProvider(new PrivateStore(), 'key', http.fetcher);
    const badSize = request('gemini-3.1-flash-image', {
      output: {
        width: 1025,
        height: 1024,
        format: 'png',
        allowedNativeDimensions: [{ width: 1025, height: 1024 }],
      },
    });
    expect(() => provider.validate(badSize, context())).toThrow();
    const badAllowed = request('gemini-3.1-flash-image', {
      output: {
        width: 1024,
        height: 1024,
        format: 'png',
        allowedNativeDimensions: [{ width: 2048, height: 2048 }],
      },
    });
    expect(() => provider.validate(badAllowed, context())).toThrow();
    const twoLiteImages = request('gemini-3.1-flash-lite-image', {
      images: [
        {
          assetId: 'a',
          role: 'reference',
          order: 0,
          sha256: 'a'.repeat(64),
          mimeType: 'image/png',
          width: 1,
          height: 1,
          objectKey: 'a',
        },
        {
          assetId: 'b',
          role: 'subject',
          order: 1,
          sha256: 'b'.repeat(64),
          mimeType: 'image/png',
          width: 1,
          height: 1,
          objectKey: 'b',
        },
      ],
    });
    expect(() => provider.validate(twoLiteImages, context())).toThrow();
    const duplicateOrder = request('gemini-3.1-flash-image', {
      images: [
        {
          assetId: 'a',
          role: 'reference',
          order: 0,
          sha256: 'a'.repeat(64),
          mimeType: 'image/png',
          width: 1,
          height: 1,
          objectKey: 'a',
        },
        {
          assetId: 'b',
          role: 'subject',
          order: 0,
          sha256: 'b'.repeat(64),
          mimeType: 'image/png',
          width: 1,
          height: 1,
          objectKey: 'b',
        },
      ],
    });
    expect(() => provider.validate(duplicateOrder, context())).toThrow();
    expect(http.calls).toHaveLength(0);
  });

  it('only accepts one final model_output image and excludes thought images', async () => {
    const thought = {
      type: 'thought',
      summary: [{ type: 'image', data: squarePng.toString('base64'), mime_type: 'image/png' }],
    };
    const noFinal = googleSuccess(squarePng, { steps: [thought] });
    const multiple = googleSuccess(squarePng, {
      steps: [thought, ...googleSuccess(squarePng).steps, ...googleSuccess(squarePng).steps],
    });
    for (const body of [noFinal, multiple]) {
      const http = fakeFetch(() => jsonResponse(body));
      const result = await new GoogleImageProvider(new PrivateStore(), 'key', http.fetcher).submit(
        request('gemini-3.1-flash-image'),
        context(),
      );
      expect(result).toMatchObject({
        kind: 'rejected',
        failure: { code: 'invalid_output', acceptance: 'accepted', billing: 'unknown' },
      });
      expect(http.calls).toHaveLength(1);
    }
  });

  it.each(['in_progress', 'requires_action', 'unrecognized', undefined])(
    'keeps a 2xx interaction with status %s unknown instead of terminally rejecting it',
    async (status) => {
      const http = fakeFetch(() => jsonResponse(googleSuccess(squarePng, { status })));
      const provider = new GoogleImageProvider(new PrivateStore(), 'key', http.fetcher);

      const result = await provider.submit(request('gemini-3.1-flash-image'), context());

      expect(result).toMatchObject({
        kind: 'unknown',
        ref: { providerRequestId: 'google-interaction-7' },
        failure: {
          code: 'server_error',
          acceptance: 'unknown',
          billing: 'unknown',
          usageComplete: true,
          usage: [
            { dimension: 'input_text_tokens', quantity: '11' },
            { dimension: 'input_image_tokens', quantity: '0' },
            { dimension: 'output_text_tokens', quantity: '0' },
            { dimension: 'output_image_tokens', quantity: '256' },
            { dimension: 'thought_tokens', quantity: '3' },
          ],
        },
      });
      expect(http.calls).toHaveLength(1);
    },
  );
});

describe('OpenAI Images REST adapter', () => {
  it('sends the selected model ID upstream instead of the adapter default', async () => {
    const http = fakeFetch((_url, init) => {
      expect(JSON.parse(String(init.body))).toMatchObject({
        model: 'gpt-image-2.5-sunburst',
        size: '1024x1024',
        quality: 'medium',
        output_format: 'png',
      });
      return jsonResponse(openaiSuccess(squarePng));
    });
    const provider = new OpenAIImageProvider(new PrivateStore(), 'openai-secret', http.fetcher);

    const completed = await outputBytes(
      await provider.submit(request('gpt-image-2.5-sunburst'), context()),
    );

    expect(http.calls).toHaveLength(1);
    expect(completed.bytes).toEqual(squarePng);
  });

  it('rejects a Google-protocol model ID before any network call', async () => {
    const http = fakeFetch(() => jsonResponse(openaiSuccess(squarePng)));
    const provider = new OpenAIImageProvider(new PrivateStore(), 'openai-secret', http.fetcher);
    // Supply the quality field explicitly: without it the quality guard would reject first and
    // this test would stop proving anything about the model-ID allow-list.
    const wrongProtocol = request('gemini-3.1-flash-image', {
      output: {
        width: 1024,
        height: 1024,
        format: 'png',
        quality: 'medium',
        allowedNativeDimensions: [{ width: 1024, height: 1024 }],
      },
    });

    expect(() => provider.validate(wrongProtocol)).toThrow(/unsupported model/i);
    expect(await provider.submit(wrongProtocol, context())).toMatchObject({
      kind: 'rejected',
      failure: { code: 'unsupported' },
    });
    expect(http.calls).toHaveLength(0);
  });

  it('uses JSON generations with the reviewed model and output preset', async () => {
    const http = fakeFetch((_url, init) => {
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer openai-secret');
      expect(new Headers(init.headers).get('content-type')).toBe('application/json');
      const body = JSON.parse(String(init.body));
      expect(body).toEqual({
        model: 'gpt-image-2',
        prompt: 'Paint a quiet blue house.',
        n: 1,
        size: '1024x1024',
        quality: 'medium',
        output_format: 'png',
      });
      expect(body.response_format).toBeUndefined();
      expect(body.input_fidelity).toBeUndefined();
      return jsonResponse(openaiSuccess(squarePng), 200, { 'x-request-id': 'openai-request-2' });
    });
    const provider = new OpenAIImageProvider(new PrivateStore(), 'openai-secret', http.fetcher);

    const completed = await outputBytes(await provider.submit(request('gpt-image-2'), context()));

    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]?.url).toBe('https://api.openai.com/v1/images/generations');
    expect(completed.bytes).toEqual(squarePng);
    expect(completed.result.ref?.providerRequestId).toBe('openai-request-2');
    expect(completed.result.usage).toEqual([
      { dimension: 'input_text_tokens', quantity: '12', unit: 'token', source: 'response' },
      { dimension: 'input_image_tokens', quantity: '0', unit: 'token', source: 'response' },
      { dimension: 'output_image_tokens', quantity: '100', unit: 'token', source: 'response' },
    ]);
    expect(completed.result.usageComplete).toBe(true);
  });

  it('uses ordered multipart edits and omits unsupported fidelity/response fields', async () => {
    const store = new PrivateStore(
      new Map([
        ['private/reference', referencePng],
        ['private/subject', subjectPng],
      ]),
    );
    const http = fakeFetch(async (_url, init) => {
      expect(new Headers(init.headers).get('content-type')).toBeNull();
      expect(init.body).toBeInstanceOf(FormData);
      const form = init.body as FormData;
      expect(
        Object.fromEntries([...form.entries()].filter(([, value]) => typeof value === 'string')),
      ).toEqual({
        model: 'gpt-image-2',
        prompt:
          'Paint a quiet blue house.\n\nInput images by declared order:\norder=0 role=reference\norder=1 role=subject',
        n: '1',
        size: '1024x1024',
        quality: 'medium',
        output_format: 'png',
      });
      expect(form.has('input_fidelity')).toBe(false);
      expect(form.has('response_format')).toBe(false);
      const files = form.getAll('image[]');
      expect(files).toHaveLength(2);
      expect(Buffer.from(await (files[0] as Blob).arrayBuffer())).toEqual(referencePng);
      expect(Buffer.from(await (files[1] as Blob).arrayBuffer())).toEqual(subjectPng);
      return jsonResponse(openaiSuccess(squarePng));
    });
    const provider = new OpenAIImageProvider(store, 'key', http.fetcher);
    const withImages = request('gpt-image-2', {
      images: [
        {
          assetId: 'subject',
          role: 'subject',
          order: 1,
          sha256: digest(subjectPng),
          mimeType: 'image/png',
          width: 12,
          height: 20,
          objectKey: 'private/subject',
        },
        {
          assetId: 'reference',
          role: 'reference',
          order: 0,
          sha256: digest(referencePng),
          mimeType: 'image/png',
          width: 20,
          height: 12,
          objectKey: 'private/reference',
        },
      ],
    });

    expect((await provider.submit(withImages, context())).kind).toBe('completed');
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]?.url).toBe('https://api.openai.com/v1/images/edits');
  });

  it('maps a reviewed flexible non-square preset exactly', async () => {
    const portraitPng = await png(1024, 1536, '#4c1d95');
    const http = fakeFetch((_url, init) => {
      expect(JSON.parse(String(init.body)).size).toBe('1024x1536');
      return jsonResponse({ ...openaiSuccess(portraitPng), size: '1024x1536' });
    });
    const provider = new OpenAIImageProvider(new PrivateStore(), 'key', http.fetcher);
    const portrait = request('gpt-image-2', {
      outputSpecId: 'png-1k-2x3-v1',
      output: {
        width: 1024,
        height: 1536,
        format: 'png',
        quality: 'medium',
        allowedNativeDimensions: [{ width: 1024, height: 1536 }],
      },
    });

    const completed = await outputBytes(await provider.submit(portrait, context()));
    expect(await sharp(completed.bytes).metadata()).toMatchObject({ width: 1024, height: 1536 });
  });

  it('accepts documented responses that omit optional format and size metadata', async () => {
    const response = openaiSuccess(squarePng) as Record<string, unknown>;
    delete response.output_format;
    delete response.size;
    const http = fakeFetch(() =>
      jsonResponse(response, 200, { 'x-request-id': 'openai-optional-1' }),
    );

    const result = await new OpenAIImageProvider(new PrivateStore(), 'key', http.fetcher).submit(
      request('gpt-image-2'),
      context(),
    );

    expect(result).toMatchObject({
      kind: 'completed',
      ref: { providerRequestId: 'openai-optional-1' },
      usageComplete: true,
    });
  });

  it('rejects optional response quality metadata that contradicts the fixed medium request', async () => {
    const http = fakeFetch(() =>
      jsonResponse({ ...openaiSuccess(squarePng), quality: 'low' }, 200, {
        'x-request-id': 'openai-quality-mismatch-1',
      }),
    );

    const result = await new OpenAIImageProvider(new PrivateStore(), 'key', http.fetcher).submit(
      request('gpt-image-2'),
      context(),
    );

    expect(result).toMatchObject({
      kind: 'rejected',
      ref: { providerRequestId: 'openai-quality-mismatch-1' },
      failure: {
        code: 'invalid_output',
        acceptance: 'accepted',
        billing: 'unknown',
        usageComplete: true,
      },
    });
    expect(http.calls).toHaveLength(1);
  });
});

describe.each([
  [
    'google',
    () => new GoogleImageProvider(new PrivateStore(), 'super-secret-google', undefined),
    () => request('gemini-3.1-flash-image'),
  ],
  [
    'openai',
    () => new OpenAIImageProvider(new PrivateStore(), 'super-secret-openai', undefined),
    () => request('gpt-image-2'),
  ],
] as const)('%s transport boundaries', (_name, makeProvider, makeRequest) => {
  it.each([
    [401, 'auth'],
    [429, 'rate_limit'],
    [500, 'server_error'],
  ] as const)(
    'classifies HTTP %s without exposing upstream bodies or credentials',
    async (status, code) => {
      const secret = _name === 'google' ? 'super-secret-google' : 'super-secret-openai';
      const http = fakeFetch(() =>
        jsonResponse({ error: { message: `leak ${secret}` } }, status, { 'retry-after': '2' }),
      );
      const provider =
        _name === 'google'
          ? new GoogleImageProvider(new PrivateStore(), secret, http.fetcher)
          : new OpenAIImageProvider(new PrivateStore(), secret, http.fetcher);

      const result = await provider.submit(makeRequest(), context());

      const expectedAcceptance = status === 500 ? 'unknown' : 'not_accepted';
      expect(result).toMatchObject({
        kind: status === 500 ? 'unknown' : 'rejected',
        failure: {
          code,
          acceptance: expectedAcceptance,
          billing: status === 500 ? 'unknown' : 'not_billable',
        },
      });
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain('leak');
      expect(http.calls).toHaveLength(1);
    },
  );

  it.each([401, 429, 500])('cancels the unread HTTP %s response body', async (status) => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() {},
      cancel() {
        cancelled = true;
      },
    });
    const http = fakeFetch(() => new Response(body, { status }));
    const provider =
      _name === 'google'
        ? new GoogleImageProvider(new PrivateStore(), 'key', http.fetcher)
        : new OpenAIImageProvider(new PrivateStore(), 'key', http.fetcher);

    await provider.submit(makeRequest(), context());

    expect(cancelled).toBe(true);
    expect(http.calls).toHaveLength(1);
  });

  it('does not call fetch when already aborted, but treats an abort after send as unknown', async () => {
    const before = new AbortController();
    before.abort();
    const never = fakeFetch(() => {
      throw new Error('must not be called');
    });
    const beforeProvider =
      _name === 'google'
        ? new GoogleImageProvider(new PrivateStore(), 'key', never.fetcher)
        : new OpenAIImageProvider(new PrivateStore(), 'key', never.fetcher);
    expect(await beforeProvider.submit(makeRequest(), context(before.signal))).toMatchObject({
      kind: 'rejected',
      failure: { code: 'timeout', acceptance: 'not_accepted', billing: 'not_billable' },
    });
    expect(never.calls).toHaveLength(0);

    const after = new AbortController();
    const hanging = fakeFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
          after.abort();
        }),
    );
    const afterProvider =
      _name === 'google'
        ? new GoogleImageProvider(new PrivateStore(), 'key', hanging.fetcher)
        : new OpenAIImageProvider(new PrivateStore(), 'key', hanging.fetcher);
    expect(await afterProvider.submit(makeRequest(), context(after.signal))).toMatchObject({
      kind: 'unknown',
      failure: { code: 'timeout', acceptance: 'unknown', billing: 'unknown' },
    });
    expect(hanging.calls).toHaveLength(1);
  });

  it('enforces responseTimeoutMs after the single send', async () => {
    const hanging = fakeFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('timed out', 'AbortError')),
            { once: true },
          );
        }),
    );
    const provider =
      _name === 'google'
        ? new GoogleImageProvider(new PrivateStore(), 'key', hanging.fetcher)
        : new OpenAIImageProvider(new PrivateStore(), 'key', hanging.fetcher);

    expect(await provider.submit(makeRequest(), context(undefined, 5))).toMatchObject({
      kind: 'unknown',
      failure: { code: 'timeout', acceptance: 'unknown', billing: 'unknown' },
    });
    expect(hanging.calls).toHaveLength(1);
  });

  it('cancels a stalled successful response body when responseTimeoutMs expires', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() {},
      cancel() {
        cancelled = true;
      },
    });
    const http = fakeFetch(() => new Response(body, { status: 200 }));
    const provider =
      _name === 'google'
        ? new GoogleImageProvider(new PrivateStore(), 'key', http.fetcher)
        : new OpenAIImageProvider(new PrivateStore(), 'key', http.fetcher);

    expect(await provider.submit(makeRequest(), context(undefined, 5))).toMatchObject({
      kind: 'unknown',
      failure: { code: 'timeout', acceptance: 'unknown', billing: 'unknown' },
    });
    expect(cancelled).toBe(true);
    expect(http.calls).toHaveLength(1);
  });
});

describe('malformed success and usage accounting', () => {
  it.each([
    ['invalid Base64', '%%%%'],
    ['non-PNG bytes', Buffer.from('not an image').toString('base64')],
  ])('treats Google %s as accepted with unknown billing', async (_label, data) => {
    const body = googleSuccess(squarePng);
    (body.steps[0]!.content[0] as { data: string }).data = data;
    const http = fakeFetch(() => jsonResponse(body));
    const result = await new GoogleImageProvider(new PrivateStore(), 'key', http.fetcher).submit(
      request('gemini-3.1-flash-image'),
      context(),
    );
    expect(result).toMatchObject({
      kind: 'rejected',
      failure: {
        code: 'invalid_output',
        acceptance: 'accepted',
        billing: 'unknown',
        usageComplete: true,
      },
    });
  });

  it('preserves valid Google usage lines but marks missing, malformed, cached, tool, and unreconciled usage incomplete', async () => {
    const usages = [
      null,
      { input_tokens_by_modality: [{ modality: 'text', tokens: 4 }], total_input_tokens: 4 },
      { ...googleSuccess(squarePng).usage, total_cached_tokens: 2 },
      { ...googleSuccess(squarePng).usage, total_tool_use_tokens: 2 },
      { ...googleSuccess(squarePng).usage, total_tokens: 999 },
      { ...googleSuccess(squarePng).usage, total_thought_tokens: 1.5 },
    ];
    for (const usage of usages) {
      const http = fakeFetch(() => jsonResponse(googleSuccess(squarePng, { usage })));
      const result = await new GoogleImageProvider(new PrivateStore(), 'key', http.fetcher).submit(
        request('gemini-3.1-flash-image'),
        context(),
      );
      expect(result.kind).toBe('completed');
      if (result.kind === 'completed') expect(result.usageComplete).toBe(false);
    }
  });

  it('preserves valid OpenAI usage lines but marks partial, malformed, cached, and unreconciled usage incomplete', async () => {
    const usages = [
      null,
      { input_tokens: 4, input_tokens_details: { text_tokens: 4 } },
      {
        input_tokens: 4,
        input_tokens_details: { text_tokens: 4, image_tokens: 0, cached_tokens: 1 },
        output_tokens: 10,
        total_tokens: 14,
      },
      {
        input_tokens: 4,
        input_tokens_details: { text_tokens: 4, image_tokens: 0 },
        output_tokens: -1,
        total_tokens: 3,
      },
      {
        input_tokens: 4,
        input_tokens_details: { text_tokens: 4, image_tokens: 0 },
        output_tokens: 10,
        total_tokens: 99,
      },
    ];
    for (const usage of usages) {
      const http = fakeFetch(() => jsonResponse(openaiSuccess(squarePng, usage)));
      const result = await new OpenAIImageProvider(new PrivateStore(), 'key', http.fetcher).submit(
        request('gpt-image-2'),
        context(),
      );
      expect(result.kind).toBe('completed');
      if (result.kind === 'completed') expect(result.usageComplete).toBe(false);
    }
  });

  it('normalizes OpenAI output token details and rejects a mismatched breakdown as complete usage', async () => {
    const completeUsage = {
      input_tokens: 12,
      input_tokens_details: { text_tokens: 10, image_tokens: 2 },
      output_tokens: 100,
      output_tokens_details: { text_tokens: 7, image_tokens: 93 },
      total_tokens: 112,
    };
    const completeHttp = fakeFetch(() => jsonResponse(openaiSuccess(squarePng, completeUsage)));
    const complete = await new OpenAIImageProvider(
      new PrivateStore(),
      'key',
      completeHttp.fetcher,
    ).submit(request('gpt-image-2'), context());
    expect(complete).toMatchObject({
      kind: 'completed',
      usage: [
        { dimension: 'input_text_tokens', quantity: '10' },
        { dimension: 'input_image_tokens', quantity: '2' },
        { dimension: 'output_text_tokens', quantity: '7' },
        { dimension: 'output_image_tokens', quantity: '93' },
      ],
      usageComplete: true,
    });

    const mismatchHttp = fakeFetch(() =>
      jsonResponse(
        openaiSuccess(squarePng, {
          ...completeUsage,
          output_tokens_details: { text_tokens: 7, image_tokens: 92 },
        }),
      ),
    );
    const mismatch = await new OpenAIImageProvider(
      new PrivateStore(),
      'key',
      mismatchHttp.fetcher,
    ).submit(request('gpt-image-2'), context());
    expect(mismatch).toMatchObject({ kind: 'completed', usageComplete: false });
  });

  it('bounds successful JSON responses and makes no retry', async () => {
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 137; i += 1) controller.enqueue(chunk);
        controller.close();
      },
    });
    const http = fakeFetch(
      () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const result = await new GoogleImageProvider(new PrivateStore(), 'key', http.fetcher).submit(
      request('gemini-3.1-flash-image'),
      context(),
    );
    expect(result).toMatchObject({
      kind: 'rejected',
      failure: { code: 'invalid_output', acceptance: 'accepted', billing: 'unknown' },
    });
    expect(http.calls).toHaveLength(1);
  });
});
