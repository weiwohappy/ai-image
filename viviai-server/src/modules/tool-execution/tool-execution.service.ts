import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService } from '../../shared/database/database.service.js';
import { AppError } from '../../shared/http/errors.js';
import { CatalogService } from '../catalog/catalog.service.js';
import { GenerationService } from '../generation/generation.service.js';
import { compileTool } from './tool-compiler.js';
import { parseToolQuoteInput } from './tool-input.js';

const toolRunSchema = z.object({ quoteId: z.uuid() }).strict();

@Injectable()
export class ToolExecutionService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(GenerationService) private readonly generation: GenerationService,
  ) {}

  async quote(userId: string, raw: unknown) {
    const input = parseToolQuoteInput(raw);
    const definition = await this.loadPublishedTool(input.toolId);
    const assets = await this.resolveAssets(userId, input.assetIds);
    const compiled = compileTool(definition, input, assets);
    const quote = await this.catalog.createQuote(userId, compiled.generationInput, {
      type: 'tool',
      id: definition.externalId,
      version: definition.version,
      snapshot: compiled.originSnapshot,
    });
    return {
      quoteId: quote.id,
      toolId: definition.externalId,
      toolVersion: definition.version,
      modelId: compiled.generationInput.modelId,
      resolution: compiled.generationInput.resolution,
      ratio: compiled.generationInput.ratio,
      count: compiled.generationInput.count,
      unitCredits: quote.unitCredits,
      totalCredits: quote.totalCredits,
      createdAt: quote.createdAt,
      expiresAt: quote.expiresAt,
    };
  }

  async run(userId: string, raw: unknown, key: string) {
    const parsed = toolRunSchema.safeParse(raw);
    if (!parsed.success)
      throw new AppError(400, 'INVALID_INPUT', 'A quote id is required to run a tool');
    const quote = await this.db.client.generationQuote.findFirst({
      where: { id: parsed.data.quoteId, userId },
    });
    if (!quote) throw new AppError(404, 'NOT_FOUND', 'Quote not found');
    if (quote.originType !== 'tool')
      throw new AppError(409, 'ORIGIN_MISMATCH', 'Quote is not a tool quote');
    return this.generation.createFromQuote(userId, quote.id, key, {
      type: 'tool',
      id: quote.originId!,
      version: quote.originVersion!,
    });
  }

  private async loadPublishedTool(externalId: string) {
    const definition = await this.db.client.toolDefinition.findFirst({
      where: { externalId, status: 'published' },
    });
    if (!definition) throw new AppError(404, 'TOOL_NOT_FOUND', 'Tool is unavailable');
    return definition;
  }

  private async resolveAssets(userId: string, assetIds: string[]): Promise<string[]> {
    if (assetIds.length === 0) return [];
    const rows = await this.db.client.asset.findMany({
      where: { id: { in: assetIds }, userId, deletedAt: null, status: 'ready' },
      select: { id: true },
    });
    const owned = new Set(rows.map((row) => row.id));
    return assetIds.map((id) => {
      if (!owned.has(id)) throw new AppError(404, 'NOT_FOUND', 'Reference image not found');
      return id;
    });
  }
}
