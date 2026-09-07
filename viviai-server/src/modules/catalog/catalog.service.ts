import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '../../config.js';
import { APP_CONFIG } from '../../shared/infrastructure.module.js';
import { DatabaseService, type DbTransaction } from '../../shared/database/database.service.js';
import { AppError } from '../../shared/http/errors.js';
import { safeInteger } from '../../shared/database/locks.js';
import { digest, normalizeInput, PRODUCT_ID, type GenerationInput } from './input-schema.js';

@Injectable()
export class CatalogService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService, @Inject(APP_CONFIG) private readonly config: AppConfig) {}
  models() {
    return this.config.simulationProviderEnabled ? [{ id: PRODUCT_ID, name: '模拟图片（非 AI）', simulated: true, resolutions: ['1K'], ratios: ['1:1'], formats: ['png'], unitCredits: 30 }] : [];
  }
  requireAvailable() { if (!this.config.simulationProviderEnabled || this.config.nodeEnv === 'production') throw new AppError(503, 'MODEL_UNAVAILABLE', 'No enabled model is available'); }
  async references(tx: DbTransaction, userId: string, input: GenerationInput) {
    const images = [];
    for (const [role, id] of [['reference', input.referenceAssetId], ['subject', input.subjectAssetId]] as const) {
      if (!id) continue;
      const asset = await tx.asset.findFirst({ where: { id, userId, deletedAt: null, status: 'ready' } });
      if (!asset) throw new AppError(404, 'NOT_FOUND', 'Reference image not found');
      images.push({ assetId: id, role, order: images.length, sha256: asset.sha256, mimeType: asset.contentType, width: asset.width, height: asset.height, objectKey: asset.objectKey });
    }
    return images;
  }
  async quote(userId: string, raw: unknown) {
    this.requireAvailable(); const input = normalizeInput(raw);
    const record = await this.db.transaction(async tx => {
      const images = await this.references(tx, userId, input);
      const createdAt = new Date();
      return tx.generationQuote.create({ data: { userId, input, inputHash: digest({ input, images }), productVersion: PRODUCT_ID,
        unitCredits: 30n, totalCredits: BigInt(input.count) * 30n, createdAt, expiresAt: new Date(createdAt.getTime() + 300_000) } });
    });
    return { id: record.id, input, inputHash: record.inputHash, unitCredits: safeInteger(record.unitCredits), totalCredits: safeInteger(record.totalCredits), createdAt: record.createdAt.toISOString(), expiresAt: record.expiresAt.toISOString() };
  }
}
