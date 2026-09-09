import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '../../config.js';
import { APP_CONFIG } from '../../shared/infrastructure.module.js';
import { DatabaseService, type DbTransaction } from '../../shared/database/database.service.js';
import { AppError } from '../../shared/http/errors.js';
import { safeInteger } from '../../shared/database/locks.js';
import { digest, normalizeInput, PRODUCT_ID, type GenerationInput } from './input-schema.js';
import { OFFICIAL_MODELS, officialSpecs } from '../providers/official-models.js';
import { officialSnapshot } from '../providers/official-config.js';

@Injectable()
export class CatalogService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}
  models() {
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
    const official = (this.config.officialImages?.models ?? []).map((model) => {
      const definition = OFFICIAL_MODELS.find((d) => d.id === model.modelId)!;
      const specs = officialSpecs(model.modelId)
        .filter((s) => model.sales[s.resolution])
        .map((s) => ({ ...s, unitCredits: model.sales[s.resolution] }));
      return {
        id: model.modelId,
        name: definition.name,
        simulated: false,
        resolutions: [...new Set(specs.map((s) => s.resolution))],
        ratios: [...new Set(specs.map((s) => s.ratio))],
        formats: ['png'],
        quality: 'standard',
        maxReferenceImages: definition.maxImages,
        specs,
        unitCredits: Math.min(...specs.map((s) => s.unitCredits!)),
      };
    });
    return [...simulated, ...official];
  }
  requireAvailable(modelId: string = PRODUCT_ID) {
    if (!this.models().some((model) => model.id === modelId))
      throw new AppError(503, 'MODEL_UNAVAILABLE', 'No enabled model is available');
  }
  execution(input: GenerationInput) {
    this.requireAvailable(input.modelId);
    if (input.modelId === PRODUCT_ID) return;
    const snapshot = officialSnapshot(
      this.config.officialImages,
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
  async quote(userId: string, raw: unknown) {
    const input = normalizeInput(raw);
    const execution = this.execution(input);
    const unitCredits = BigInt(execution?.unitCredits ?? 30);
    const record = await this.db.transaction(async (tx) => {
      const images = await this.references(tx, userId, input);
      const createdAt = new Date();
      return tx.generationQuote.create({
        data: {
          userId,
          input,
          inputHash: digest({ input, images }),
          productVersion: input.modelId,
          ...(execution
            ? {
                execution:
                  execution as unknown as import('../../generated/prisma/client.js').Prisma.InputJsonValue,
              }
            : {}),
          unitCredits,
          totalCredits: BigInt(input.count) * unitCredits,
          createdAt,
          expiresAt: new Date(createdAt.getTime() + 300_000),
        },
      });
    });
    return {
      id: record.id,
      input,
      inputHash: record.inputHash,
      unitCredits: safeInteger(record.unitCredits),
      totalCredits: safeInteger(record.totalCredits),
      createdAt: record.createdAt.toISOString(),
      expiresAt: record.expiresAt.toISOString(),
    };
  }
}
