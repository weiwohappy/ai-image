import type { ThirdPartyProviderConfig } from '../third-party-config.js';

export type ProviderVerification =
  | { ok: true; modelId: string; modelListed: true; responseReceived: true }
  | {
      ok: false;
      code:
        'auth' | 'model_not_found' | 'endpoint_not_found' | 'rate_limit' | 'timeout' | 'upstream';
      message: string;
    };

interface ModelsResponse {
  data?: unknown;
}

interface ChatResponse {
  choices?: unknown;
}

const safeMessages: Record<Exclude<ProviderVerification, { ok: true }>['code'], string> = {
  auth: 'Provider authentication failed',
  model_not_found: 'Configured model is not available',
  endpoint_not_found: 'Provider endpoint was not found',
  rate_limit: 'Provider rate limit reached',
  timeout: 'Provider verification timed out',
  upstream: 'Provider verification failed',
};

export class OpenAICompatibleChatClient {
  constructor(
    private readonly config: Pick<ThirdPartyProviderConfig, 'baseUrl' | 'apiKey' | 'modelId'>,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async verify(signal?: AbortSignal): Promise<ProviderVerification> {
    const requestSignal = signal ?? AbortSignal.timeout(15_000);
    const headers = {
      authorization: `Bearer ${this.config.apiKey}`,
      accept: 'application/json',
    };
    let models: Response;
    try {
      models = await this.fetcher(`${this.config.baseUrl}/models`, {
        method: 'GET',
        headers,
        redirect: 'error',
        signal: requestSignal,
      });
    } catch {
      return requestSignal.aborted
        ? { ok: false, code: 'timeout', message: safeMessages.timeout }
        : { ok: false, code: 'upstream', message: safeMessages.upstream };
    }
    const modelFailure = classifyStatus(models.status);
    if (modelFailure) return modelFailure;
    let payload: ModelsResponse;
    try {
      payload = (await boundedJson(models)) as ModelsResponse;
    } catch {
      return { ok: false, code: 'upstream', message: safeMessages.upstream };
    }
    const listed = Array.isArray(payload.data)
      ? payload.data.some(
          (item) =>
            typeof item === 'object' &&
            item !== null &&
            'id' in item &&
            (item as { id?: unknown }).id === this.config.modelId,
        )
      : false;
    if (!listed)
      return { ok: false, code: 'model_not_found', message: safeMessages.model_not_found };

    let completion: Response;
    try {
      completion = await this.fetcher(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.config.modelId,
          messages: [{ role: 'user', content: 'Reply with OK.' }],
          max_tokens: 8,
          stream: false,
        }),
        redirect: 'error',
        signal: requestSignal,
      });
    } catch {
      return requestSignal.aborted
        ? { ok: false, code: 'timeout', message: safeMessages.timeout }
        : { ok: false, code: 'upstream', message: safeMessages.upstream };
    }
    const completionFailure = classifyStatus(completion.status);
    if (completionFailure) return completionFailure;
    try {
      const response = (await boundedJson(completion)) as ChatResponse;
      const choice = Array.isArray(response.choices) ? response.choices[0] : undefined;
      if (
        !choice ||
        typeof choice !== 'object' ||
        choice === null ||
        !('message' in choice) ||
        !choice.message ||
        typeof choice.message !== 'object' ||
        !('content' in choice.message) ||
        typeof choice.message.content !== 'string'
      )
        return { ok: false, code: 'upstream', message: safeMessages.upstream };
    } catch {
      return { ok: false, code: 'upstream', message: safeMessages.upstream };
    }
    return { ok: true, modelId: this.config.modelId, modelListed: true, responseReceived: true };
  }
}

function classifyStatus(status: number): ProviderVerification | undefined {
  if (status === 401 || status === 403)
    return { ok: false, code: 'auth', message: safeMessages.auth };
  if (status === 404)
    return { ok: false, code: 'endpoint_not_found', message: safeMessages.endpoint_not_found };
  if (status === 429) return { ok: false, code: 'rate_limit', message: safeMessages.rate_limit };
  if (status >= 400) return { ok: false, code: 'upstream', message: safeMessages.upstream };
  return undefined;
}

async function boundedJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > 2 * 1024 * 1024)
    throw new Error('Response exceeds limit');
  const text = await response.text();
  if (text.length > 2 * 1024 * 1024) throw new Error('Response exceeds limit');
  return JSON.parse(text) as unknown;
}
