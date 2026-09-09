export type ImageRole = 'reference' | 'subject' | 'context';
export type Acceptance = 'not_accepted' | 'accepted' | 'unknown';
export type BillingCertainty = 'not_billable' | 'billable' | 'unknown';
export type ExecutionMode = 'interactive' | 'deferred';

export interface InputImage {
  assetId: string;
  role: ImageRole;
  order: number;
  sha256: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  width: number;
  height: number;
  objectKey: string;
}

export interface NormalizedImageRequest {
  channelId?: string;
  providerRegion?: string;
  pricing?: import('./pricing.js').PriceSnapshot;
  jobId: string;
  itemId: string;
  attemptId: string;
  productModelVersionId: string;
  upstreamModelId: string;
  outputSpecId: string;
  prompt: string;
  promptTemplateVersion: string;
  images: InputImage[];
  output: {
    width: number;
    height: number;
    format: 'png' | 'jpeg' | 'webp';
    quality?: 'low' | 'medium' | 'high';
    allowedNativeDimensions: Array<{ width: number; height: number }>;
  };
  count: 1;
  executionMode: ExecutionMode;
  businessDeadlineAt: string;
  providerContextRef?: string;
}

export interface ProviderContext {
  channelId: string;
  credentialVersionRef: string;
  baseUrl: string;
  region: string;
  capabilityVersionId: string;
  requestKey: string;
  connectTimeoutMs: number;
  responseTimeoutMs: number;
  remoteDeadlineAt?: string;
  signal: AbortSignal;
}

export interface ProviderRef {
  providerRequestId: string;
  channelId: string;
  credentialVersionRef: string;
}

export interface UsageLine {
  dimension: string;
  quantity: string;
  unit: 'token' | 'image' | 'second' | 'request' | 'byte';
  source: 'response' | 'invoice' | 'estimate' | 'allocated';
}

export type ProviderOutput =
  | { kind: 'stream'; content: AsyncIterable<Uint8Array>; mimeType: string }
  | { kind: 'remote_url'; url: string; expiresAt?: string };

export interface CompletedResult {
  kind: 'completed';
  ref?: ProviderRef;
  outputs: ProviderOutput[];
  usage: UsageLine[];
  usageComplete: boolean;
  providerContextRef?: string;
}

export interface ProviderFailure {
  code:
    | 'invalid_input'
    | 'unsupported'
    | 'auth'
    | 'quota'
    | 'rate_limit'
    | 'content_rejected'
    | 'server_error'
    | 'transport_error'
    | 'timeout'
    | 'invalid_output';
  acceptance: Acceptance;
  billing: BillingCertainty;
  usage?: UsageLine[];
  usageComplete?: boolean;
  retryAfterMs?: number;
  safeMessage: string;
  diagnosticRef?: string;
}

export type SubmitResult =
  | CompletedResult
  | { kind: 'accepted'; ref: ProviderRef; pollAfterMs: number }
  | { kind: 'rejected'; ref?: ProviderRef; failure: ProviderFailure }
  | { kind: 'unknown'; ref?: ProviderRef; failure: ProviderFailure };

export type QueryResult =
  | CompletedResult
  | { kind: 'pending'; ref: ProviderRef; pollAfterMs: number }
  | { kind: 'failed'; failure: ProviderFailure }
  | { kind: 'cancelled'; billing: BillingCertainty; usage?: UsageLine[] }
  | {
      kind: 'not_found';
      authoritative: boolean;
      disposition: 'never_accepted' | 'expired_or_deleted' | 'unknown';
    };

export type CancelResult =
  | { kind: 'confirmed'; billing: BillingCertainty; usage?: UsageLine[] }
  | { kind: 'requested' }
  | { kind: 'unsupported' }
  | { kind: 'unknown' };

export interface VerifiedWebhook {
  dedupeKey: string;
  providerRequestId: string;
  eventType: string;
  occurredAt?: string;
  payloadDigest: string;
  normalized: QueryResult;
}

export interface ProviderCapabilities {
  submitMode: 'sync' | 'async' | 'both';
  supportsQuery: boolean;
  supportsCancel: boolean;
  supportsRemoteDeadline: boolean;
  webhookVerification: 'signed' | 'none';
  idempotency: 'documented' | 'none';
  maxReferenceImages: number;
  maxOutputImages: number;
  supportedRoles: ImageRole[];
  inputTransport: Array<'inline_bytes' | 'multipart' | 'url' | 'provider_file'>;
  supportsProviderContext: boolean;
  executionModes: ExecutionMode[];
}

export interface ProviderAdapter {
  readonly protocol: string;
  capabilities(context: ProviderContext): ProviderCapabilities;
  validate(request: NormalizedImageRequest, context: ProviderContext): void;
  submit(request: NormalizedImageRequest, context: ProviderContext): Promise<SubmitResult>;
  query?(ref: ProviderRef, context: ProviderContext): Promise<QueryResult>;
  cancel?(ref: ProviderRef, context: ProviderContext): Promise<CancelResult>;
  verifyAndParseWebhook?(
    rawBody: Uint8Array,
    headers: Record<string, string>,
    context: ProviderContext,
  ): Promise<VerifiedWebhook>;
}
