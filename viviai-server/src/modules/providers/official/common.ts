import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { ObjectStore } from '../../assets/object-store.js';
import type {
  InputImage,
  NormalizedImageRequest,
  ProviderContext,
  ProviderFailure,
  ProviderRef,
  SubmitResult,
  UsageLine,
} from '../contracts.js';
import { getOfficialOutputSpec, type OfficialOutputSpec } from '../official-models.js';

export const MAX_RESPONSE_JSON_BYTES = 136 * 1024 * 1024;
export const MAX_GENERATED_IMAGE_BYTES = 96 * 1024 * 1024;
export const MAX_REFERENCE_IMAGE_BYTES = 5 * 1024 * 1024;

export class ResponseBoundaryError extends Error {}

export interface LoadedInput {
  image: InputImage;
  bytes: Uint8Array;
}

export function validateOfficialRequest(
  request: NormalizedImageRequest,
  supportedModels: readonly string[],
  maximumImages: number,
): OfficialOutputSpec {
  if (!supportedModels.includes(request.upstreamModelId)) throw new Error('Unsupported model');
  const spec = getOfficialOutputSpec(request.upstreamModelId, request.outputSpecId);
  const allowed = request.output.allowedNativeDimensions;
  if (
    !spec ||
    request.output.format !== 'png' ||
    request.output.width !== spec.width ||
    request.output.height !== spec.height ||
    allowed.length !== 1 ||
    allowed[0]?.width !== spec.width ||
    allowed[0]?.height !== spec.height ||
    request.count !== 1 ||
    request.executionMode !== 'interactive' ||
    request.providerContextRef !== undefined ||
    request.images.length > maximumImages ||
    request.images.some(
      (image) =>
        !['reference', 'subject'].includes(image.role) ||
        !Number.isSafeInteger(image.order) ||
        image.order < 0 ||
        !/^[a-f\d]{64}$/i.test(image.sha256),
    ) ||
    new Set(request.images.map((image) => image.order)).size !== request.images.length
  )
    throw new Error('Unsupported official image parameters');
  return spec;
}

export async function loadPrivateInputs(
  store: ObjectStore,
  request: NormalizedImageRequest,
): Promise<LoadedInput[] | undefined> {
  const loaded: LoadedInput[] = [];
  for (const image of [...request.images].sort((a, b) => a.order - b.order)) {
    try {
      const bytes = await store.get(image.objectKey);
      if (
        bytes.byteLength > MAX_REFERENCE_IMAGE_BYTES ||
        createHash('sha256').update(bytes).digest('hex') !== image.sha256.toLowerCase()
      )
        return undefined;
      loaded.push({ image, bytes });
    } catch {
      return undefined;
    }
  }
  return loaded;
}

export function promptWithImageLabels(prompt: string, inputs: readonly LoadedInput[]) {
  if (inputs.length === 0) return prompt;
  return `${prompt}\n\nInput images by declared order:\n${inputs
    .map(({ image }) => `order=${image.order} role=${image.role}`)
    .join('\n')}`;
}

export function makeRequestSignal(context: ProviderContext) {
  const timeout = new AbortController();
  const timer = setTimeout(
    () => timeout.abort(new DOMException('response timeout', 'TimeoutError')),
    Math.max(1, context.responseTimeoutMs),
  );
  timer.unref();
  return {
    signal: AbortSignal.any([context.signal, timeout.signal]),
    cleanup: () => clearTimeout(timer),
  };
}

export async function fetchOnce(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  context: ProviderContext,
  signal: AbortSignal,
): Promise<Response | SubmitResult> {
  if (context.signal.aborted)
    return rejectedFailure('timeout', 'Request was cancelled before submission');
  try {
    return await fetcher(url, { ...init, redirect: 'error', signal });
  } catch {
    return unknownFailure(
      signal.aborted ? 'timeout' : 'transport_error',
      'Provider response is unknown',
    );
  }
}

export function classifyHttpFailure(response: Response): SubmitResult {
  const status = response.status;
  if (status === 401 || status === 403)
    return rejectedFailure('auth', 'Provider authentication failed');
  if (status === 429) {
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
    return {
      kind: 'rejected',
      failure: {
        code: 'rate_limit',
        acceptance: 'not_accepted',
        billing: 'not_billable',
        safeMessage: 'Provider rate limit reached',
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      },
    };
  }
  if (status === 402) return rejectedFailure('quota', 'Provider quota is unavailable');
  if (status >= 400 && status < 500 && status !== 408)
    return rejectedFailure('invalid_input', 'Provider rejected the request');
  return unknownFailure(
    status === 408 ? 'timeout' : 'server_error',
    'Provider response is unknown',
  );
}

export async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new ResponseBoundaryError('Missing response body');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await readWithAbort(reader, signal);
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > MAX_RESPONSE_JSON_BYTES) {
        await reader.cancel();
        throw new ResponseBoundaryError('Response exceeds limit');
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof ResponseBoundaryError) throw error;
    throw new ResponseBoundaryError('Invalid provider response');
  }
}

async function readWithAbort(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal) {
  if (signal.aborted) throw signal.reason;
  let remove = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    remove = () => signal.removeEventListener('abort', onAbort);
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    remove();
  }
}

export function strictBase64(value: unknown): Uint8Array {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/.test(value)
  )
    throw new ResponseBoundaryError('Invalid encoded image');
  const estimatedBytes =
    (value.length / 4) * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);
  if (estimatedBytes > MAX_GENERATED_IMAGE_BYTES)
    throw new ResponseBoundaryError('Generated image exceeds limit');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new ResponseBoundaryError('Invalid encoded image');
  return bytes;
}

export async function validateGeneratedImage(
  bytes: Uint8Array,
  spec: OfficialOutputSpec,
  allowedMimeTypes: readonly string[],
): Promise<string> {
  try {
    const metadata = await sharp(bytes, {
      failOn: 'warning',
      animated: true,
      limitInputPixels: Math.max(40_000_000, spec.width * spec.height),
    }).metadata();
    const mimeType =
      metadata.format === 'png'
        ? 'image/png'
        : metadata.format === 'jpeg'
          ? 'image/jpeg'
          : metadata.format === 'webp'
            ? 'image/webp'
            : undefined;
    if (
      !mimeType ||
      !allowedMimeTypes.includes(mimeType) ||
      (metadata.pages ?? 1) !== 1 ||
      metadata.width !== spec.width ||
      metadata.height !== spec.height
    )
      throw new Error('Unexpected image contract');
    return mimeType;
  } catch {
    throw new ResponseBoundaryError('Invalid generated image');
  }
}

export function completedOutput(
  bytes: Uint8Array,
  ref: ProviderRef | undefined,
  usage: UsageLine[],
  usageComplete: boolean,
  mimeType = 'image/png',
): SubmitResult {
  const immutable = Buffer.from(bytes);
  return {
    kind: 'completed',
    ...(ref === undefined ? {} : { ref }),
    outputs: [
      {
        kind: 'stream',
        mimeType,
        content: (async function* () {
          yield immutable;
        })(),
      },
    ],
    usage,
    usageComplete,
  };
}

export function providerRef(id: unknown, context: ProviderContext): ProviderRef | undefined {
  if (typeof id !== 'string' || id.length === 0) return undefined;
  return {
    providerRequestId: id,
    channelId: context.channelId,
    credentialVersionRef: context.credentialVersionRef,
  };
}

export function rejectedFailure(code: ProviderFailure['code'], safeMessage: string): SubmitResult {
  return {
    kind: 'rejected',
    failure: { code, acceptance: 'not_accepted', billing: 'not_billable', safeMessage },
  };
}

export function unknownFailure(
  code: ProviderFailure['code'],
  safeMessage: string,
  acceptance: 'accepted' | 'unknown' = 'unknown',
  ref?: ProviderRef,
): SubmitResult {
  return {
    kind: 'unknown',
    ...(ref === undefined ? {} : { ref }),
    failure: { code, acceptance, billing: 'unknown', safeMessage },
  };
}

export function invalidOutputFailure(
  usage?: UsageLine[],
  usageComplete?: boolean,
  ref?: ProviderRef,
): SubmitResult {
  return {
    kind: 'rejected',
    ...(ref === undefined ? {} : { ref }),
    failure: {
      code: 'invalid_output',
      acceptance: 'accepted',
      billing: 'unknown',
      safeMessage: 'Provider returned an invalid image',
      ...(usage === undefined ? {} : { usage }),
      ...(usageComplete === undefined ? {} : { usageComplete }),
    },
  };
}

export function tokenLine(dimension: string, quantity: number): UsageLine {
  return { dimension, quantity: String(quantity), unit: 'token', source: 'response' };
}

export function isToken(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function plainObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}
