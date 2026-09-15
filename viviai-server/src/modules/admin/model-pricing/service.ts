import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { ModelCreditPrice } from '../../../generated/prisma/client.js';
import { lockCreditPrice } from '../../catalog/credit-pricing.js';
import { OFFICIAL_MODELS, officialSpecs } from '../../providers/official-models.js';
import { resolveImageExecution } from '../../providers/image-execution.js';
import type { AdminContext } from '../auth.service.js';
import { parse } from '../auth.controller.js';
import { requirePermission } from '../permissions.js';
import { AdminTeamCommands } from '../team/command.service.js';
import { failure, teamWritesEnabled } from '../team/policy.js';
import { modelIdSchema, priceTuple, type ModelPriceRow, type SaveModelPrice } from './contracts.js';

@Injectable()
export class AdminModelPricingService {
  constructor(@Inject(AdminTeamCommands) readonly commands: AdminTeamCommands) {}
  private dto(
    context: AdminContext,
    modelId: string,
    resolution: string,
    price?: ModelCreditPrice | null,
  ): ModelPriceRow {
    const definition = OFFICIAL_MODELS.find((m) => m.id === modelId)!;
    const specs = officialSpecs(modelId).filter((s) => s.resolution === resolution);
    // Availability is decided by the same judgment the public catalog publishes from, so a model
    // whose only enabled channel is third-party is not reported here as runtime unavailable.
    const runtimeAvailable = specs.some(
      (s) => !!resolveImageExecution(this.commands.config, modelId, resolution, s.ratio),
    );
    const reasonCode = !teamWritesEnabled(this.commands.config, context.requestIp)
      ? 'ADMIN_TEAM_WRITES_DISABLED'
      : !context.actor.permissions.includes('model-pricing.write') ||
          !context.actor.permissions.includes('models.read')
        ? 'ADMIN_FORBIDDEN'
        : null;
    const actions = price
      ? (['edit', price.enabled ? 'disable' : 'enable'] as const)
      : (['create'] as const);
    return {
      modelId,
      resolution,
      name: definition.name,
      provider: definition.provider,
      specs: specs.map(({ id, resolution, ratio, width, height }) => ({
        id,
        resolution,
        ratio,
        width,
        height,
      })),
      priceId: price?.id ?? null,
      unitCredits: price?.unitCredits ?? null,
      enabled: price?.enabled ?? false,
      version: price?.version ?? 0,
      updatedAt: price?.updatedAt.toISOString() ?? null,
      runtimeAvailable,
      availabilityReason: !price
        ? 'unpriced'
        : !price.enabled
          ? 'price_disabled'
          : !runtimeAvailable
            ? 'runtime_unavailable'
            : 'available',
      allowedActions: actions.map((action) => ({ action, allowed: !reasonCode, reasonCode })),
    };
  }
  async list(context: AdminContext, raw: unknown) {
    requirePermission(context.actor, 'models.read');
    const q = parse(z.object({ modelId: modelIdSchema.optional() }).strict(), raw);
    const prices = await this.commands.db.client.modelCreditPrice.findMany({
      where: q.modelId ? { modelId: q.modelId } : {},
    });
    return {
      items: OFFICIAL_MODELS.filter((m) => !q.modelId || m.id === q.modelId).flatMap((m) =>
        [...new Set(officialSpecs(m.id).map((s) => s.resolution))].map((r) =>
          this.dto(
            context,
            m.id,
            r,
            prices.find((p) => p.modelId === m.id && p.resolution === r),
          ),
        ),
      ),
      asOf: new Date().toISOString(),
      writeEnabled: teamWritesEnabled(this.commands.config, context.requestIp),
    };
  }
  async detail(context: AdminContext, modelId: string, resolution: string) {
    requirePermission(context.actor, 'models.read');
    const tuple = priceTuple(modelId, resolution);
    return this.dto(
      context,
      modelId,
      resolution,
      await this.commands.db.client.modelCreditPrice.findUnique({
        where: { modelId_resolution: tuple },
      }),
    );
  }
  save(
    context: AdminContext,
    key: string,
    modelId: string,
    resolution: string,
    input: SaveModelPrice,
  ) {
    const tuple = priceTuple(modelId, resolution);
    return this.commands.run(
      context,
      key,
      'model-pricing.save',
      `${modelId}:${resolution}`,
      input,
      'model-pricing.write',
      async (tx, current) => {
        await lockCreditPrice(tx, modelId, resolution);
        const before = await tx.modelCreditPrice.findUnique({
          where: { modelId_resolution: tuple },
        });
        if ((before?.version ?? 0) !== input.expectedVersion)
          throw failure(409, 'PRICE_VERSION_CONFLICT', '价格已更新，请重新加载后比较');
        const changedFields = (['unitCredits', 'enabled'] as const).filter(
          (k) => before?.[k] !== input[k],
        );
        if (before?.version === 2147483647 && changedFields.length)
          throw failure(409, 'PRICE_VERSION_CONFLICT', '价格版本已达上限');
        const after = !before
          ? await tx.modelCreditPrice.create({
              data: {
                ...tuple,
                unitCredits: input.unitCredits,
                enabled: input.enabled,
                updatedBy: current.actor.id,
              },
            })
          : changedFields.length
            ? await tx.modelCreditPrice.update({
                where: { id: before.id },
                data: {
                  unitCredits: input.unitCredits,
                  enabled: input.enabled,
                  version: { increment: 1 },
                  updatedBy: current.actor.id,
                },
              })
            : before;
        return {
          result: { resourceId: after.id, version: after.version },
          metadata: {
            modelId,
            resolution,
            changedFields,
            beforeUnitCredits: before?.unitCredits ?? null,
            afterUnitCredits: after.unitCredits,
            beforeEnabled: before?.enabled ?? null,
            afterEnabled: after.enabled,
            beforeVersion: before?.version ?? 0,
            afterVersion: after.version,
          },
        };
      },
    );
  }
  async history(context: AdminContext, modelId: string, raw: unknown) {
    requirePermission(context.actor, 'models.read');
    parse(z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/), modelId);
    const q = parse(
      z
        .object({
          resolution: z
            .string()
            .regex(/^[a-zA-Z0-9._-]{1,16}$/)
            .optional(),
          cursor: z.string().min(1).max(2048).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(30),
        })
        .strict(),
      raw,
    );
    // Historical resolution identifiers need not still be an offered specification.
    let cursor:
      | { id: string; createdAt: string; asOf: string; modelId: string; resolution: string | null }
      | undefined;
    if (q.cursor) {
      try {
        cursor = z
          .object({
            id: z.uuid(),
            createdAt: z.iso.datetime(),
            asOf: z.iso.datetime(),
            modelId: z.literal(modelId),
            resolution: z.literal(q.resolution ?? null),
          })
          .strict()
          .parse(JSON.parse(Buffer.from(q.cursor, 'base64url').toString()));
      } catch {
        throw failure(400, 'ADMIN_INVALID_INPUT', '分页游标无效');
      }
    }
    const asOf = cursor?.asOf ?? new Date().toISOString();
    const where = {
      AND: [
        {
          outcome: 'allowed',
          action: { in: ['model-pricing.save', 'model-pricing.import'] },
          createdAt: { lte: new Date(asOf) },
        },
        { metadata: { path: ['modelId'], equals: modelId } },
        ...(q.resolution ? [{ metadata: { path: ['resolution'], equals: q.resolution } }] : []),
      ],
    };
    if (cursor) {
      const anchor = await this.commands.db.client.adminAuditEvent.findFirst({
        where: { ...where, id: cursor.id },
        select: { createdAt: true },
      });
      if (!anchor || anchor.createdAt.toISOString() !== cursor.createdAt)
        throw failure(400, 'ADMIN_INVALID_INPUT', '分页游标无效');
    }
    const rows = await this.commands.db.client.adminAuditEvent.findMany({
      where,
      ...(cursor ? { cursor: { id: cursor.id }, skip: 1 } : {}),
      // Prisma resolves the anchor timestamp inside SQL, preserving database microseconds.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    });
    const accounts = await this.commands.db.client.adminAccount.findMany({
      where: { id: { in: rows.flatMap((r) => (r.accountId ? [r.accountId] : [])) } },
      select: { id: true, displayName: true },
    });
    const items = rows.slice(0, q.limit).map((r) => {
      const m = r.metadata as Record<string, unknown>;
      return {
        id: r.id,
        createdAt: r.createdAt.toISOString(),
        actor: r.accountId
          ? (accounts.find((a) => a.id === r.accountId)?.displayName ?? r.accountId)
          : 'offline_import',
        modelId,
        resolution: m.resolution as string,
        action: r.action,
        before: m.beforeVersion
          ? {
              unitCredits: m.beforeUnitCredits as number,
              enabled: m.beforeEnabled as boolean,
              version: m.beforeVersion as number,
            }
          : null,
        after: {
          unitCredits: m.afterUnitCredits as number,
          enabled: m.afterEnabled as boolean,
          version: m.afterVersion as number,
        },
      };
    });
    const last = items.at(-1);
    return {
      items,
      asOf,
      nextCursor:
        rows.length > q.limit && last
          ? Buffer.from(
              JSON.stringify({
                id: last.id,
                createdAt: last.createdAt,
                asOf,
                modelId,
                resolution: q.resolution ?? null,
              }),
            ).toString('base64url')
          : null,
    };
  }
}
