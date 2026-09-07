import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { ObjectStore } from '../assets/object-store.js';
import type {
  CompletedResult,
  NormalizedImageRequest,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderContext,
  ProviderRef,
  SubmitResult,
} from './contracts.js';
export class SimulatedProvider implements ProviderAdapter {
  readonly protocol = 'simulation-v1';
  constructor(
    private readonly store: ObjectStore,
    private readonly mode: 'sync' | 'async',
  ) {}
  capabilities(): ProviderCapabilities {
    return {
      submitMode: this.mode,
      supportsQuery: true,
      supportsCancel: true,
      supportsRemoteDeadline: false,
      webhookVerification: 'none',
      idempotency: 'documented',
      maxReferenceImages: 2,
      maxOutputImages: 1,
      supportedRoles: ['reference', 'subject'],
      inputTransport: ['inline_bytes'],
      supportsProviderContext: false,
      executionModes: ['interactive'],
    };
  }
  validate(request: NormalizedImageRequest) {
    if (
      request.productModelVersionId !== 'simulation-image-v1' ||
      request.upstreamModelId !== 'deterministic-png-v1' ||
      request.output.width !== 1024 ||
      request.output.height !== 1024 ||
      request.output.format !== 'png' ||
      request.count !== 1 ||
      request.images.length > 2
    )
      throw new Error('Unsupported simulation parameters');
  }
  async submit(request: NormalizedImageRequest, context: ProviderContext): Promise<SubmitResult> {
    this.validate(request);
    // Exercise the actual private input path, including both roles. No paid API.
    for (const image of request.images) {
      const bytes = await this.store.get(image.objectKey);
      if (createHash('sha256').update(bytes).digest('hex') !== image.sha256)
        return {
          kind: 'rejected',
          failure: {
            code: 'invalid_input',
            acceptance: 'not_accepted',
            billing: 'not_billable',
            safeMessage: 'Reference integrity check failed',
          },
        };
    }
    const ref = {
      providerRequestId: request.attemptId,
      channelId: context.channelId,
      credentialVersionRef: context.credentialVersionRef,
    };
    return this.mode === 'async' ? { kind: 'accepted', ref, pollAfterMs: 500 } : this.query(ref);
  }
  async query(ref: ProviderRef): Promise<CompletedResult> {
    const shade = createHash('sha256').update(ref.providerRequestId).digest()[0] ?? 128;
    const label = Buffer.from(
      '<svg width="1024" height="1024"><text x="512" y="495" text-anchor="middle" font-family="sans-serif" font-size="56" fill="white">SIMULATION</text><text x="512" y="555" text-anchor="middle" font-family="sans-serif" font-size="32" fill="white">NOT AI GENERATED</text></svg>',
    );
    const bytes = await sharp({
      create: { width: 1024, height: 1024, channels: 3, background: { r: 30, g: 90, b: shade } },
    })
      .composite([{ input: label }])
      .png()
      .toBuffer();
    return {
      kind: 'completed',
      ref,
      outputs: [
        {
          kind: 'stream',
          mimeType: 'image/png',
          content: (async function* () {
            yield bytes;
          })(),
        },
      ],
      usage: [{ dimension: 'simulation_image', quantity: '1', unit: 'image', source: 'response' }],
      usageComplete: true,
    };
  }
  async cancel() {
    return { kind: 'confirmed' as const, billing: 'not_billable' as const, usage: [] };
  }
}
