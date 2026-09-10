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

const OPENAI_MODEL = ['gpt-image-2'] as const;
const OPENAI_GENERATIONS_URL = 'https://api.openai.com/v1/images/generations';
const OPENAI_EDITS_URL = 'https://api.openai.com/v1/images/edits';

export class OpenAIImageProvider implements ProviderAdapter {
  readonly protocol = OFFICIAL_PROTOCOLS.openai;

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
      inputTransport: ['multipart'],
      supportsProviderContext: false,
      executionModes: ['interactive'],
    };
  }

  validate(request: NormalizedImageRequest, _context?: ProviderContext) {
    if (request.output.quality !== 'medium') throw new Error('GPT Image 2 uses medium quality');
    validateOfficialRequest(request, OPENAI_MODEL, 2);
  }

  async submit(request: NormalizedImageRequest, context: ProviderContext): Promise<SubmitResult> {
    let spec;
    try {
      if (request.output.quality !== 'medium') throw new Error('GPT Image 2 uses medium quality');
      spec = validateOfficialRequest(request, OPENAI_MODEL, 2);
    } catch {
      return rejectedFailure('unsupported', 'Unsupported official image parameters');
    }
    if (context.signal.aborted)
      return rejectedFailure('timeout', 'Request was cancelled before submission');
    const inputs = await loadPrivateInputs(this.store, request);
    if (!inputs) return rejectedFailure('invalid_input', 'Reference integrity check failed');
    const prompt = promptWithImageLabels(request.prompt, inputs);
    const fields = {
      model: 'gpt-image-2',
      prompt,
      n: 1,
      size: `${spec.width}x${spec.height}`,
      quality: 'medium',
      output_format: 'png',
    } as const;
    let url = OPENAI_GENERATIONS_URL;
    let headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      'content-type': 'application/json',
    };
    let body: RequestInit['body'] = JSON.stringify(fields);
    if (inputs.length > 0) {
      url = OPENAI_EDITS_URL;
      headers = { authorization: `Bearer ${this.apiKey}` };
      const form = new FormData();
      for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
      for (const [index, { image, bytes }] of inputs.entries()) {
        const extension = image.mimeType === 'image/jpeg' ? 'jpg' : image.mimeType.split('/')[1]!;
        form.append(
          'image[]',
          new Blob([bytes], { type: image.mimeType }),
          `input-${index + 1}.${extension}`,
        );
      }
      body = form;
    }
    const requestTimeout = makeRequestSignal(context);
    try {
      const response = await fetchOnce(
        this.fetcher,
        url,
        { method: 'POST', headers, body },
        context,
        requestTimeout.signal,
      );
      if (!(response instanceof Response)) return response;
      if (!response.ok) return classifyHttpFailure(response);
      const ref = providerRef(response.headers.get('x-request-id'), context);
      let payload: unknown;
      try {
        payload = await readBoundedJson(response, requestTimeout.signal);
      } catch {
        if (requestTimeout.signal.aborted)
          return unknownFailure('timeout', 'Provider response is unknown', 'unknown', ref);
        return invalidOutputFailure(undefined, undefined, ref);
      }
      try {
        const root = plainObject(payload);
        const usage = openaiUsage(root?.usage);
        if (
          !root ||
          (root.output_format !== undefined && root.output_format !== 'png') ||
          (root.size !== undefined && root.size !== `${spec.width}x${spec.height}`) ||
          (root.quality !== undefined && root.quality !== 'medium') ||
          !Array.isArray(root.data) ||
          root.data.length !== 1
        )
          throw new Error('Invalid Images response');
        const image = plainObject(root.data[0]);
        const bytes = strictBase64(image?.b64_json);
        await validateGeneratedImage(bytes, spec, ['image/png']);
        return completedOutput(bytes, ref, usage.lines, usage.complete);
      } catch {
        const usage = openaiUsage(plainObject(payload)?.usage);
        return invalidOutputFailure(usage.lines, usage.complete, ref);
      }
    } finally {
      requestTimeout.cleanup();
    }
  }
}

function openaiUsage(value: unknown): { lines: UsageLine[]; complete: boolean } {
  const usage = plainObject(value);
  if (!usage) return { lines: [], complete: false };
  const details = plainObject(usage.input_tokens_details);
  const text = details?.text_tokens;
  const image = details?.image_tokens;
  const output = usage.output_tokens;
  const hasOutputDetails = usage.output_tokens_details !== undefined;
  const outputDetails = plainObject(usage.output_tokens_details);
  const outputText = outputDetails?.text_tokens;
  const outputImage = outputDetails?.image_tokens;
  const input = usage.input_tokens;
  const total = usage.total_tokens;
  const lines: UsageLine[] = [];
  if (isToken(text)) lines.push(tokenLine('input_text_tokens', text));
  if (isToken(image)) lines.push(tokenLine('input_image_tokens', image));
  if (hasOutputDetails) {
    if (isToken(outputText)) lines.push(tokenLine('output_text_tokens', outputText));
    if (isToken(outputImage)) lines.push(tokenLine('output_image_tokens', outputImage));
  } else if (isToken(output)) {
    // Images REST documents output_tokens for this endpoint's generated image output.
    lines.push(tokenLine('output_image_tokens', output));
  }
  const knownUsageKeys = new Set([
    'input_tokens',
    'input_tokens_details',
    'output_tokens',
    'output_tokens_details',
    'total_tokens',
  ]);
  const outputBreakdownComplete =
    !hasOutputDetails ||
    (!!outputDetails &&
      isToken(outputText) &&
      isToken(outputImage) &&
      isToken(output) &&
      outputText + outputImage === output &&
      Object.keys(outputDetails).every((key) => key === 'text_tokens' || key === 'image_tokens'));
  const complete =
    isToken(text) &&
    isToken(image) &&
    isToken(input) &&
    text + image === input &&
    isToken(output) &&
    isToken(total) &&
    total === input + output &&
    outputBreakdownComplete &&
    !!details &&
    Object.keys(details).every((key) => key === 'text_tokens' || key === 'image_tokens') &&
    Object.keys(usage).every((key) => knownUsageKeys.has(key));
  return { lines, complete };
}
