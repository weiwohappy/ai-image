import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '../../config.js';
import type { GenerationQuote, Prisma } from '../../generated/prisma/client.js';
import { APP_CONFIG } from '../../shared/infrastructure.module.js';
import { DatabaseService, type DbTransaction } from '../../shared/database/database.service.js';
import { AppError } from '../../shared/http/errors.js';
import { safeInteger } from '../../shared/database/locks.js';
import { digest, normalizeInput, PRODUCT_ID, type GenerationInput } from './input-schema.js';
import { OFFICIAL_MODELS, officialSpecs } from '../providers/official-models.js';
import { officialSnapshot } from '../providers/official-config.js';
import { thirdPartyImageSnapshot } from '../providers/third-party-config.js';
import { activeCreditPrice } from './credit-pricing.js';

export interface QuoteOrigin {
  type: 'tool' | 'workflow';
  id: string;
  version: number;
  snapshot: Prisma.InputJsonValue;
}
export type QuoteOriginIdentity = Pick<QuoteOrigin, 'type' | 'id' | 'version'>;

export function quoteHash(input: GenerationInput, images: unknown, origin?: QuoteOrigin): string {
  return digest({
    input,
    images,
    ...(origin
      ? {
          origin: {
            type: origin.type,
            id: origin.id,
            version: origin.version,
            snapshot: origin.snapshot,
          },
        }
      : {}),
  });
}

export function originOf(quote: {
  originType: string | null;
  originId: string | null;
  originVersion: number | null;
  originSnapshot: Prisma.JsonValue | null;
}): QuoteOrigin | undefined {
  if (quote.originType !== 'tool' && quote.originType !== 'workflow') return undefined;
  return {
    type: quote.originType,
    id: quote.originId!,
    version: quote.originVersion!,
    snapshot: quote.originSnapshot as unknown as Prisma.InputJsonValue,
  };
}

export function resolveImageExecution(
  config: Pick<AppConfig, 'officialImages' | 'thirdPartyImages'>,
  modelId: string,
  resolution: string,
  ratio: string,
) {
  return (
    officialSnapshot(config.officialImages, modelId, resolution, ratio) ??
    thirdPartyImageSnapshot(config.thirdPartyImages, modelId, resolution, ratio)
  );
}

@Injectable()
export class CatalogService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}
  async models() {
    const simulated =
      this.config.simulationProviderEnabled && this.config.nodeEnv !== 'production'
        ? [
            {
              id: PRODUCT_ID,
              name: '模拟图片（非 AI）',
              simulated: true,
              resolutions: ['1K'],
              ratios: ['1:1'],
              formats: ['png'],
              unitCredits: 30,
            },
          ]
        : [];
    const prices = await this.db.client.modelCreditPrice.findMany({ where: { enabled: true } });
    const configuredModelIds = new Set([
      ...(this.config.officialImages?.models ?? []).map((model) => model.modelId),
      ...(this.config.thirdPartyImages?.models ?? []).map((model) => model.modelId),
    ]);
    const official = OFFICIAL_MODELS.filter((definition) =>
      configuredModelIds.has(definition.id),
    ).flatMap((definition) => {
      const specs = officialSpecs(definition.id).flatMap((s) => {
        const price = prices.find(
          (p) => p.modelId === definition.id && p.resolution === s.resolution,
        );
        return price &&
          (officialSnapshot(this.config.officialImages, definition.id, s.resolution, s.ratio) ??
            thirdPartyImageSnapshot(
              this.config.thirdPartyImages,
              definition.id,
              s.resolution,
              s.ratio,
            ))
          ? [{ ...s, unitCredits: price.unitCredits }]
          : [];
      });
      if (!specs.length) return [];
      return [
        {
          id: definition.id,
          name: definition.name,
          simulated: false,
          resolutions: [...new Set(specs.map((s) => s.resolution))],
          ratios: [...new Set(specs.map((s) => s.ratio))],
          formats: ['png'],
          quality: 'standard',
          maxReferenceImages: definition.maxImages,
          specs,
          unitCredits: Math.min(...specs.map((s) => s.unitCredits!)),
        },
      ];
    });
    return [...simulated, ...official];
  }
  requireAvailable(modelId: string = PRODUCT_ID) {
    const configured = new Set<string>([
      ...(this.config.officialImages?.models ?? []).map((model) => model.modelId),
      ...(this.config.thirdPartyImages?.models ?? []).map((model) => model.modelId),
    ]);
    if (
      modelId === PRODUCT_ID
        ? !(this.config.simulationProviderEnabled && this.config.nodeEnv !== 'production')
        : !configured.has(modelId)
    )
      throw new AppError(503, 'MODEL_UNAVAILABLE', 'No enabled model is available');
  }
  execution(input: GenerationInput) {
    this.requireAvailable(input.modelId);
    if (input.modelId === PRODUCT_ID) return;
    const snapshot = resolveImageExecution(
      this.config,
      input.modelId,
      input.resolution,
      input.ratio,
    );
    if (!snapshot)
      throw new AppError(503, 'MODEL_UNAVAILABLE', 'Model specification is not enabled');
    return snapshot;
  }
  async references(tx: DbTransaction, userId: string, input: GenerationInput) {
    const images = [];
    for (const [role, id] of [
      ['reference', input.referenceAssetId],
      ['subject', input.subjectAssetId],
    ] as const) {
      if (!id) continue;
      const asset = await tx.asset.findFirst({
        where: { id, userId, deletedAt: null, status: 'ready' },
      });
      if (!asset) throw new AppError(404, 'NOT_FOUND', 'Reference image not found');
      images.push({
        assetId: id,
        role,
        order: images.length,
        sha256: asset.sha256,
        mimeType: asset.contentType,
        width: asset.width,
        height: asset.height,
        objectKey: asset.objectKey,
      });
    }
    return images;
  }
  quote(userId: string, raw: unknown) {
    return this.createQuote(userId, raw);
  }
  async createQuote(userId: string, rawInput: unknown, origin?: QuoteOrigin) {
    const input = normalizeInput(rawInput);
    return this.db.transaction((tx) => this.createQuoteIn(tx, userId, input, origin));
  }
  /**
   * Creates one generation quote inside a caller-owned transaction so aggregate
   * products (workflow batches) can write every child quote atomically.
   */
  async createQuoteIn(
    tx: DbTransaction,
    userId: string,
    input: GenerationInput,
    origin?: QuoteOrigin,
  ) {
    const price =
      input.modelId === PRODUCT_ID
        ? undefined
        : await activeCreditPrice(tx, input.modelId, input.resolution, 503);
    const execution = this.execution(input);
    const unitCredits = BigInt(price?.unitCredits ?? 30);
    const images = await this.references(tx, userId, input);
    const createdAt = new Date();
    const record = await tx.generationQuote.create({
      data: {
        userId,
        input,
        inputHash: quoteHash(input, images, origin),
        productVersion: input.modelId,
        ...(price ? { creditPriceSnapshot: price } : {}),
        ...(execution ? { execution: execution as unknown as Prisma.InputJsonValue } : {}),
        unitCredits,
        totalCredits: BigInt(input.count) * unitCredits,
        createdAt,
        expiresAt: new Date(createdAt.getTime() + 300_000),
        ...(origin
          ? {
              originType: origin.type,
              originId: origin.id,
              originVersion: origin.version,
              originSnapshot: origin.snapshot,
            }
          : {}),
      },
    });
    return { ...presentQuote(record), input };
  }
}

function presentQuote(record: GenerationQuote) {
  return {
    id: record.id,
    inputHash: record.inputHash,
    unitCredits: safeInteger(record.unitCredits),
    totalCredits: safeInteger(record.totalCredits),
    priceVersion: record.creditPriceSnapshot
      ? (record.creditPriceSnapshot as { version: number }).version
      : null,
    createdAt: record.createdAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
  };
}
