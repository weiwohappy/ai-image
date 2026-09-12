import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { AppConfig } from '../../../config.js';
import type { DbTransaction } from '../../../shared/database/database.service.js';
import { AppError } from '../../../shared/http/errors.js';
import { APP_CONFIG } from '../../../shared/infrastructure.module.js';
import { ASSET_STORE } from '../../assets/assets.service.js';
import type { ObjectStore } from '../../assets/object-store.js';
import { activeCreditPrice } from '../../catalog/credit-pricing.js';
import { resolveImageExecution } from '../../catalog/catalog.service.js';
import {
  inspirationInputSchema,
  remixTemplateInputSchema,
  toolDefinitionInputSchema,
} from '../../content/content-contracts.js';
import { getOfficialOutputSpec } from '../../providers/official-models.js';
import type { ContentKind } from './content.service.js';
import { lockContentResources } from '../../content/content-locks.js';

const rasterTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);

type Row = Record<string, unknown>;

function validationFailure(path: string) {
  const field = path || 'content';
  return new AppError(422, 'CONTENT_NOT_PUBLISHABLE', `无法发布：${field}`, {
    field,
    details: { reason: 'not_publishable' },
  });
}

@Injectable()
export class AdminContentPublishValidator {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ASSET_STORE) private readonly store: ObjectStore,
  ) {}

  async validate(tx: DbTransaction, kind: ContentKind, row: Row): Promise<void> {
    const mediaFields =
      kind === 'inspirations'
        ? ([
            ['coverMediaId', 'coverMediaExternalId', true],
            ['caseMediaId', 'caseMediaExternalId', false],
          ] as const)
        : kind === 'remix-templates'
          ? ([
              ['coverMediaId', 'coverMediaExternalId', true],
              ['referenceMediaId', 'referenceMediaExternalId', false],
            ] as const)
          : ([
              ['coverMediaId', 'coverMediaExternalId', true],
              ['iconMediaId', 'iconMediaExternalId', false],
            ] as const);
    const ids = mediaFields
      .map(([field]) => row[field])
      .filter((value): value is string => typeof value === 'string');
    await lockContentResources(
      tx,
      ids.map((id) => `media:${id}`),
    );
    const media = await tx.contentMedia.findMany({ where: { id: { in: ids } } });
    const byId = new Map(media.map((item) => [item.id, item]));
    const external: Record<string, string> = {};
    for (const [databaseField, contractField, required] of mediaFields) {
      const id = row[databaseField];
      if ((required && typeof id !== 'string') || (typeof id === 'string' && !byId.has(id)))
        throw validationFailure(contractField);
      if (typeof id !== 'string') continue;
      const item = byId.get(id)!;
      if (item.status !== 'published' || !rasterTypes.has(item.contentType))
        throw validationFailure(contractField);
      let bytes: Uint8Array;
      try {
        bytes = await this.store.get(item.objectKey);
      } catch {
        throw validationFailure(contractField);
      }
      if (
        bytes.byteLength !== item.byteSize ||
        createHash('sha256').update(bytes).digest('hex') !== item.sha256
      )
        throw validationFailure(contractField);
      external[contractField] = item.externalId;
    }

    const candidate = this.contract(kind, row, external);
    const parsed = this.schema(kind).safeParse(candidate);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw validationFailure(issue?.path.join('.') ?? 'content');
    }
    const model = String(row.defaultModelId);
    const outputSpecId = String(row.defaultOutputSpecId);
    const spec = getOfficialOutputSpec(model, outputSpecId);
    if (!spec || !resolveImageExecution(this.config, model, spec.resolution, spec.ratio))
      throw validationFailure('defaultOutputSpecId');
    if (kind === 'tools') {
      const defaults = z
        .object({ resolution: z.string(), ratio: z.string() })
        .passthrough()
        .safeParse(row.defaults);
      if (
        !defaults.success ||
        defaults.data.resolution !== spec.resolution ||
        defaults.data.ratio !== spec.ratio
      )
        throw validationFailure('defaults');
    }
    try {
      await activeCreditPrice(tx, model, spec.resolution, 409);
    } catch (error) {
      if (error instanceof AppError && error.code === 'PRICE_UNAVAILABLE')
        throw validationFailure('defaultModelId');
      throw error;
    }
  }

  private schema(kind: ContentKind) {
    return kind === 'inspirations'
      ? inspirationInputSchema
      : kind === 'remix-templates'
        ? remixTemplateInputSchema
        : toolDefinitionInputSchema;
  }

  private contract(kind: ContentKind, row: Row, media: Record<string, string>): Row {
    const source = {
      ...(row.creatorName ? { creatorName: row.creatorName } : {}),
      ...(row.sourceType ? { sourceType: row.sourceType } : {}),
      ...(row.sourceName ? { sourceName: row.sourceName } : {}),
      ...(row.sourceUrl ? { sourceUrl: row.sourceUrl } : {}),
    };
    const common = {
      externalId: row.externalId,
      description: row.description,
      category: row.category,
      defaultModelId: row.defaultModelId,
      defaultOutputSpecId: row.defaultOutputSpecId,
      status: 'published',
      sortOrder: row.sortOrder,
      ...source,
      ...media,
    };
    if (kind === 'inspirations')
      return {
        ...common,
        title: row.title,
        ...(row.editorialLabel ? { editorialLabel: row.editorialLabel } : {}),
        baseLikes: row.baseLikes,
        tags: row.tags,
        defaultPrompt: row.defaultPrompt,
      };
    if (kind === 'remix-templates')
      return {
        ...common,
        title: row.title,
        platform: row.platform,
        industry: row.industry,
        style: row.style,
        ...(row.popularityLabel ? { popularityLabel: row.popularityLabel } : {}),
        baseRemixCount: row.baseRemixCount,
        tags: row.tags,
        visualAnalysis: row.visualAnalysis,
        defaultPrompt: row.defaultPrompt,
        defaultParameters: row.defaultParameters,
      };
    return {
      ...common,
      name: row.name,
      fields: row.fieldSchema,
      promptTemplate: row.promptTemplate,
      defaults: row.defaults,
      maxAssets: row.maxAssets,
      maxOutputCount: row.maxOutputCount,
      assetLabel: row.assetLabel,
      isNew: row.isNew,
    };
  }
}
