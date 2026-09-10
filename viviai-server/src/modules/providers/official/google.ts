import type { ObjectStore } from '../../assets/object-store.js';
import { OFFICIAL_PROTOCOLS } from '../official-models.js';
import type {
  NormalizedImageRequest,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderContext,
  SubmitResult,
} from '../contracts.js';
import type { UsageLine } from '../contracts.js';
import {
  classifyHttpFailure,
  completedOutput,
  fetchOnce,
  isToken,
  invalidOutputFailure,
  loadPrivateInputs,
  makeRequestSignal,
  plainObject,
  promptWithImageLabels,
  providerRef,
  readBoundedJson,
  rejectedFailure,
  strictBase64,
  tokenLine,
  unknownFailure,
  validateGeneratedImage,
  validateOfficialRequest,
} from './common.js';

const GOOGLE_MODELS = [
  'gemini-2.5-flash-image',
  'gemini-3.1-flash-lite-image',
  'gemini-3.1-flash-image',
  'gemini-3-pro-image',
] as const;
const GOOGLE_INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';

export class GoogleImageProvider implements ProviderAdapter {
  readonly protocol = OFFICIAL_PROTOCOLS.google;

  constructor(
    private readonly store: ObjectStore,
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  capabilities(): ProviderCapabilities {
    return {
      submitMode: 'sync',
      supportsQuery: false,
      supportsCancel: false,
      supportsRemoteDeadline: false,
      webhookVerification: 'none',
      idempotency: 'none',
      maxReferenceImages: 2,
      maxOutputImages: 1,
      supportedRoles: ['reference', 'subject'],
      inputTransport: ['inline_bytes'],
      supportsProviderContext: false,
      executionModes: ['interactive'],
    };
  }

  validate(request: NormalizedImageRequest, _context?: ProviderContext) {
    if (request.output.quality !== undefined) throw new Error('Google uses native image quality');
    validateOfficialRequest(
      request,
      GOOGLE_MODELS,
      request.upstreamModelId === 'gemini-3.1-flash-lite-image' ? 1 : 2,
    );
  }

  async submit(request: NormalizedImageRequest, context: ProviderContext): Promise<SubmitResult> {
    let spec;
    try {
      if (request.output.quality !== undefined) throw new Error('Google uses native image quality');
      spec = validateOfficialRequest(
        request,
        GOOGLE_MODELS,
        request.upstreamModelId === 'gemini-3.1-flash-lite-image' ? 1 : 2,
      );
    } catch {
      return rejectedFailure('unsupported', 'Unsupported official image parameters');
    }
    if (context.signal.aborted)
      return rejectedFailure('timeout', 'Request was cancelled before submission');
    const inputs = await loadPrivateInputs(this.store, request);
    if (!inputs) return rejectedFailure('invalid_input', 'Reference integrity check failed');
    const labeledPrompt = promptWithImageLabels(request.prompt, inputs);
    const input =
      inputs.length === 0
        ? labeledPrompt
        : [
            { type: 'text', text: labeledPrompt },
            ...inputs.map(({ image, bytes }) => ({
              type: 'image',
              data: Buffer.from(bytes).toString('base64'),
              mime_type: image.mimeType,
            })),
          ];
    const requestTimeout = makeRequestSignal(context);
    try {
      const response = await fetchOnce(
        this.fetcher,
        GOOGLE_INTERACTIONS_URL,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
          body: JSON.stringify({
            model: request.upstreamModelId,
            input,
            response_format: {
              type: 'image',
              aspect_ratio: spec.ratio,
              ...(spec.imageSize === undefined ? {} : { image_size: spec.imageSize }),
              delivery: 'inline',
            },
            store: false,
          }),
        },
        context,
        requestTimeout.signal,
      );
      if (!(response instanceof Response)) return response;
      if (!response.ok) return classifyHttpFailure(response);
      let payload: unknown;
      try {
        payload = await readBoundedJson(response, requestTimeout.signal);
      } catch {
        if (requestTimeout.signal.aborted)
          return unknownFailure('timeout', 'Provider response is unknown');
        return invalidOutputFailure();
      }
      const root = plainObject(payload);
      const ref = providerRef(root?.id, context);
      const usage = googleUsage(root?.usage);
      if (root?.status !== 'completed')
        return {
          kind: 'unknown',
          ...(ref === undefined ? {} : { ref }),
          failure: {
            code: 'server_error',
            acceptance: 'unknown',
            billing: 'unknown',
            safeMessage: 'Provider interaction did not complete synchronously',
            usage: usage.lines,
            usageComplete: usage.complete,
          },
        };
      try {
        if (!Array.isArray(root.steps)) throw new Error('Invalid interaction');
        const images: Record<string, unknown>[] = [];
        for (const rawStep of root.steps) {
          const step = plainObject(rawStep);
          if (step?.type !== 'model_output' || !Array.isArray(step.content)) continue;
          for (const rawContent of step.content) {
            const content = plainObject(rawContent);
            if (content?.type === 'image') images.push(content);
          }
        }
        const declaredMime = images[0]?.mime_type;
        if (
          images.length !== 1 ||
          (declaredMime !== 'image/png' &&
            declaredMime !== 'image/jpeg' &&
            declaredMime !== 'image/webp')
        )
          throw new Error('Expected one supported inline image');
        const bytes = strictBase64(images[0]?.data);
        const actualMime = await validateGeneratedImage(bytes, spec, [declaredMime]);
        return completedOutput(bytes, ref, usage.lines, usage.complete, actualMime);
      } catch {
        return invalidOutputFailure(usage.lines, usage.complete, ref);
      }
    } finally {
      requestTimeout.cleanup();
    }
  }
}

function googleUsage(value: unknown): { lines: UsageLine[]; complete: boolean } {
  const usage = plainObject(value);
  if (!usage) return { lines: [], complete: false };
  const input = modalityLines(usage.input_tokens_by_modality, 'input');
  const output = modalityLines(usage.output_tokens_by_modality, 'output');
  const thought = usage.total_thought_tokens;
  const cached = usage.total_cached_tokens;
  const tool = usage.total_tool_use_tokens;
  const totalInput = usage.total_input_tokens;
  const totalOutput = usage.total_output_tokens;
  const total = usage.total_tokens;
  const lines = [...input.lines, ...output.lines];
  if (isToken(thought)) lines.push(tokenLine('thought_tokens', thought));
  const knownKeys = new Set([
    'input_tokens_by_modality',
    'output_tokens_by_modality',
    'cached_tokens_by_modality',
    'total_cached_tokens',
    'total_input_tokens',
    'total_output_tokens',
    'total_thought_tokens',
    'total_tokens',
    'total_tool_use_tokens',
    'grounding_tool_count',
  ]);
  const noUnknownFields = Object.keys(usage).every((key) => knownKeys.has(key));
  const complete =
    input.valid &&
    output.valid &&
    isToken(thought) &&
    isToken(cached) &&
    cached === 0 &&
    isToken(tool) &&
    tool === 0 &&
    isToken(totalInput) &&
    input.sum === totalInput &&
    isToken(totalOutput) &&
    output.sum === totalOutput &&
    isToken(total) &&
    total === totalInput + totalOutput + thought &&
    usage.cached_tokens_by_modality === undefined &&
    usage.grounding_tool_count === undefined &&
    noUnknownFields;
  return { lines, complete };
}

function modalityLines(
  value: unknown,
  direction: 'input' | 'output',
): { lines: UsageLine[]; sum: number; valid: boolean } {
  if (!Array.isArray(value)) return { lines: [], sum: 0, valid: false };
  const values = new Map<'text' | 'image', number>();
  let valid = true;
  for (const raw of value) {
    const item = plainObject(raw);
    if (
      !item ||
      (item.modality !== 'text' && item.modality !== 'image') ||
      !isToken(item.tokens) ||
      Object.keys(item).some((key) => key !== 'modality' && key !== 'tokens') ||
      values.has(item.modality)
    ) {
      valid = false;
      continue;
    }
    values.set(item.modality, item.tokens);
  }
  const lines: UsageLine[] = [];
  for (const modality of ['text', 'image'] as const) {
    const tokens = values.get(modality);
    if (tokens !== undefined) lines.push(tokenLine(`${direction}_${modality}_tokens`, tokens));
  }
  return { lines, sum: [...values.values()].reduce((sum, tokens) => sum + tokens, 0), valid };
}
