import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Prisma } from '../../generated/prisma/client.js';
import { DatabaseService } from '../../shared/database/database.service.js';
import { APP_CONFIG } from '../../shared/infrastructure.module.js';
import type { AppConfig } from '../../config.js';
import { AppError } from '../../shared/http/errors.js';
import { OFFICIAL_MODELS, officialSpecs } from '../providers/official-models.js';
import { SIMULATED_PROFILES } from '../providers/provider-config.js';
import { budgetKey } from '../providers/accounting.js';
import { requirePermission } from './permissions.js';
import { parse } from './auth.controller.js';
import type { AdminActor, AdminDetail, AdminTable, Cell, Column, Dashboard } from './contracts.js';
import { label } from './presentation.js';

const uuid = z.uuid();
const iso = z.iso.datetime({ offset: true }).refine((s) => Number.isFinite(Date.parse(s)));
export function id(value: string) {
  return parse(uuid, value);
}
const missing = () => new AppError(404, 'ADMIN_NOT_FOUND', 'Resource not found');
const bad = () => new AppError(400, 'ADMIN_INVALID_QUERY', 'Invalid query');
const orderBy = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];
export function maskEmail(email: string) {
  const [name, domain] = email.split('@');
  return `${name?.slice(0, 1) ?? ''}***@${domain ?? '***'}`;
}
type Row = { id: string } & Record<string, Cell>;
export function table(
  title: string,
  columns: Column[],
  rows: Row[],
  nextCursor: string | null = null,
  notices: string[] = [],
): AdminTable {
  return {
    title: label(title),
    columns: columns.map((c) => ({ ...c, label: label(c.label) })),
    rows,
    nextCursor,
    asOf: new Date().toISOString(),
    notices: notices.map(label),
  };
}
function cols(...keys: string[]): Column[] {
  return keys.map((key) => ({
    key,
    label: label(key),
    ...(['status', 'acceptance', 'billing', 'certainty'].includes(key)
      ? { kind: 'status' as const }
      : {}),
    ...([
      'createdAt',
      'expiresAt',
      'paidAt',
      'fulfilledAt',
      'firstSeenAt',
      'lastSeenAt',
      'acceptedAt',
      'deliveredAt',
    ].includes(key)
      ? { kind: 'datetime' as const }
      : {}),
    ...([
      'available',
      'held',
      'consumed',
      'issued',
      'expired',
      'revoked',
      'credits',
      'unitCredits',
      'availableDelta',
      'heldDelta',
      'consumedDelta',
      'expiredDelta',
      'revokedDelta',
    ].includes(key)
      ? { kind: 'credits' as const }
      : {}),
    ...(['amountMinor', 'revenueMinor'].includes(key) ? { kind: 'cny' as const } : {}),
    ...(key.endsWith('Micros') ? { kind: 'usd' as const } : {}),
    ...(['userId', 'jobId', 'attemptId', 'orderId'].includes(key)
      ? {
          link: (
            { userId: 'users', jobId: 'jobs', attemptId: 'attempts', orderId: 'orders' } as const
          )[key as 'userId' | 'jobId' | 'attemptId' | 'orderId'],
        }
      : {}),
  }));
}
export function query(raw: unknown, allowed: string[] = []) {
  const all: Record<string, z.ZodType> = {
    cursor: z.string().max(1024),
    limit: z
      .string()
      .regex(/^[1-9]\d{0,2}$/)
      .transform(Number)
      .refine((n) => n <= 100),
    from: iso,
    to: iso,
    q: z.string().trim().min(1).max(254),
    status: z
      .string()
      .regex(/^[a-z_]+$/)
      .max(40),
    userId: uuid,
    modelId: z
      .string()
      .regex(/^[\w.-]+$/)
      .max(100),
    source: z
      .string()
      .regex(/^[\w.-]+$/)
      .max(80),
  };
  const shape: Record<string, z.ZodType> = {};
  for (const key of ['cursor', 'limit', ...allowed]) shape[key] = all[key]!.optional();
  const value = parse(z.object(shape).strict(), raw) as {
    cursor?: string;
    limit?: number;
    from?: string;
    to?: string;
    q?: string;
    status?: string;
    userId?: string;
    modelId?: string;
    source?: string;
  };
  if (value.from && value.to && Date.parse(value.from) > Date.parse(value.to)) throw bad();
  let cursorId: string | undefined;
  if (value.cursor) {
    try {
      if (!/^[\w-]+$/.test(value.cursor)) throw bad();
      const decoded = JSON.parse(Buffer.from(value.cursor, 'base64url').toString());
      const cursor = parse(
        z.object({ id: z.string().min(1).max(160), createdAt: iso }).strict(),
        decoded,
      );
      cursorId = cursor.id;
    } catch {
      throw bad();
    }
  }
  return { ...value, limit: value.limit ?? 30, cursorId };
}
type Query = ReturnType<typeof query>;
function pageArgs(q: Query) {
  if (q.cursorId && !uuid.safeParse(q.cursorId).success) throw bad();
  return {
    take: q.limit + 1,
    orderBy,
    ...(q.cursorId ? { cursor: { id: q.cursorId }, skip: 1 } : {}),
  };
}
function dateWhere(q: Query) {
  return q.from || q.to
    ? {
        createdAt: {
          ...(q.from ? { gte: new Date(q.from) } : {}),
          ...(q.to ? { lte: new Date(q.to) } : {}),
        },
      }
    : {};
}
function next(rows: { id: string; createdAt: Date }[], q: Query) {
  const last = rows[q.limit - 1];
  return rows.length > q.limit && last
    ? Buffer.from(
        JSON.stringify({ id: last.id, createdAt: last.createdAt.toISOString() }),
      ).toString('base64url')
    : null;
}
function exact(q: string | undefined, email = false) {
  if (!q) return {};
  if (uuid.safeParse(q).success) return { id: q };
  if (email && z.email().safeParse(q).success) return { email: q.toLowerCase() };
  throw bad();
}
function detail(
  title: string,
  row: Row,
  tables: AdminTable[] = [],
  notices: string[] = [],
): AdminDetail {
  return {
    id: row.id,
    title: label(title),
    fields: Object.entries(row)
      .filter(([k]) => k !== 'id')
      .map(([key, value]) => ({
        label: label(key),
        value: value === null ? null : String(value),
        ...(cols(key)[0]?.kind ? { kind: cols(key)[0]!.kind! } : {}),
      })),
    tables,
    notices: notices.map(label),
  };
}
@Injectable()
export class AdminQueryService {
  constructor(
    @Inject(DatabaseService) readonly db: DatabaseService,
    @Inject(APP_CONFIG) readonly config: AppConfig,
  ) {}
  private sqlTable(name: string) {
    const schema = new URL(this.config.databaseUrl).searchParams.get('schema') ?? 'public';
    return Prisma.raw(`"${schema.replaceAll('"', '""')}"."${name.replaceAll('"', '""')}"`);
  }
  async users(actor: AdminActor, raw: unknown): Promise<AdminTable> {
    requirePermission(actor, 'users.read');
    const q = query(raw, ['q', 'from', 'to']);
    const users = await this.db.client.user.findMany({
      ...pageArgs(q),
      where: { ...exact(q.q, true), ...dateWhere(q) },
      select: { id: true, email: true, username: true, createdAt: true },
    });
    const sums = await this.db.client.creditLot.groupBy({
      by: ['userId'],
      where: { userId: { in: users.map((u) => u.id) } },
      _sum: { available: true, held: true, consumed: true },
    });
    return table(
      'Users',
      cols('id', 'email', 'username', 'available', 'held', 'consumed', 'createdAt'),
      users.slice(0, q.limit).map((u) => {
        const sum = sums.find((s) => s.userId === u.id)?._sum;
        return {
          id: u.id,
          email: maskEmail(u.email),
          username: u.username,
          available: String(sum?.available ?? 0n),
          held: String(sum?.held ?? 0n),
          consumed: String(sum?.consumed ?? 0n),
          createdAt: u.createdAt.toISOString(),
        };
      }),
      next(users, q),
    );
  }
  async user(actor: AdminActor, userId: string) {
    const users = await this.users(actor, { q: id(userId) });
    const row = users.rows[0];
    if (!row) throw missing();
    const tables = actor.permissions.includes('credits.read')
      ? [await this.creditLots(actor, userId, {}), await this.creditEvents(actor, userId, {})]
      : [];
    return detail('User', row, tables);
  }
  async creditLots(actor: AdminActor, userId: string, raw: unknown) {
    requirePermission(actor, 'credits.read');
    const q = query(raw, ['from', 'to', 'q']);
    const rows = await this.db.client.creditLot.findMany({
      ...pageArgs(q),
      where: { userId: id(userId), ...exact(q.q), ...dateWhere(q) },
      select: {
        id: true,
        sourceId: true,
        issued: true,
        available: true,
        held: true,
        consumed: true,
        expired: true,
        revoked: true,
        revenueMinor: true,
        paymentOrderId: true,
        expiresAt: true,
        createdAt: true,
      },
    });
    const costs = actor.permissions.includes('costs.read');
    return table(
      'Credit lots',
      cols(
        'id',
        'source',
        'issued',
        'available',
        'held',
        'consumed',
        'expired',
        'revoked',
        ...(costs ? ['revenueMinor'] : []),
        'orderId',
        'expiresAt',
        'createdAt',
      ),
      rows.slice(0, q.limit).map((r) => ({
        id: r.id,
        source: r.sourceId,
        issued: String(r.issued),
        available: String(r.available),
        held: String(r.held),
        consumed: String(r.consumed),
        expired: String(r.expired),
        revoked: String(r.revoked),
        ...(costs ? { revenueMinor: String(r.revenueMinor) } : {}),
        orderId: r.paymentOrderId,
        expiresAt: r.expiresAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
      next(rows, q),
    );
  }
  async creditEvents(actor: AdminActor, userId: string, raw: unknown) {
    requirePermission(actor, 'credits.read');
    const q = query(raw, ['from', 'to', 'q', 'status']);
    const rows = await this.db.client.creditEvent.findMany({
      ...pageArgs(q),
      where: {
        userId: id(userId),
        ...exact(q.q),
        ...dateWhere(q),
        ...(q.status ? { type: q.status } : {}),
      },
      select: {
        id: true,
        lotId: true,
        type: true,
        itemId: true,
        availableDelta: true,
        heldDelta: true,
        consumedDelta: true,
        expiredDelta: true,
        revokedDelta: true,
        createdAt: true,
      },
    });
    return table(
      'Credit events',
      cols(
        'id',
        'lotId',
        'type',
        'itemId',
        'availableDelta',
        'heldDelta',
        'consumedDelta',
        'expiredDelta',
        'revokedDelta',
        'createdAt',
      ),
      rows.slice(0, q.limit).map((r) => ({
        id: r.id,
        lotId: r.lotId,
        type: r.type,
        itemId: r.itemId,
        availableDelta: String(r.availableDelta),
        heldDelta: String(r.heldDelta),
        consumedDelta: String(r.consumedDelta),
        expiredDelta: String(r.expiredDelta),
        revokedDelta: String(r.revokedDelta),
        createdAt: r.createdAt.toISOString(),
      })),
      next(rows, q),
    );
  }
  async orders(actor: AdminActor, raw: unknown) {
    requirePermission(actor, 'orders.read');
    const q = query(raw, ['q', 'status', 'userId', 'source', 'from', 'to']);
    const search = q.q
      ? uuid.safeParse(q.q).success
        ? { id: q.q }
        : /^[a-zA-Z0-9_-]{1,80}$/.test(q.q)
          ? { orderNo: q.q }
          : (() => {
              throw bad();
            })()
      : {};
    const rows = await this.db.client.paymentOrder.findMany({
      ...pageArgs(q),
      where: {
        ...search,
        ...dateWhere(q),
        ...(q.status ? { status: q.status } : {}),
        ...(q.userId ? { userId: q.userId } : {}),
        ...(q.source ? { channel: q.source } : {}),
      },
      select: {
        id: true,
        userId: true,
        orderNo: true,
        planId: true,
        amountMinor: true,
        currency: true,
        credits: true,
        channel: true,
        status: true,
        paidAt: true,
        fulfilledAt: true,
        expiresAt: true,
        createdAt: true,
      },
    });
    return table(
      'Orders',
      cols(
        'id',
        'userId',
        'orderNo',
        'planId',
        'amountMinor',
        'currency',
        'credits',
        'channel',
        'status',
        'paidAt',
        'fulfilledAt',
        'expiresAt',
        'createdAt',
      ),
      rows.slice(0, q.limit).map((r) => ({
        id: r.id,
        userId: r.userId,
        orderNo: r.orderNo,
        planId: r.planId,
        amountMinor: String(r.amountMinor),
        currency: r.currency,
        credits: String(r.credits),
        channel: r.channel,
        status: r.status,
        paidAt: r.paidAt?.toISOString() ?? null,
        fulfilledAt: r.fulfilledAt?.toISOString() ?? null,
        expiresAt: r.expiresAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
      })),
      next(rows, q),
      ['Cash refund, fees and net profit are unavailable in increment A.'],
    );
  }
  async order(actor: AdminActor, orderId: string) {
    const row = (await this.orders(actor, { q: id(orderId) })).rows[0];
    if (!row) throw missing();
    return detail(
      'Order',
      row,
      [],
      ['Checkout, merchant configuration and verification payload are excluded.'],
    );
  }
  async jobs(actor: AdminActor, raw: unknown) {
    requirePermission(actor, 'jobs.read');
    const q = query(raw, ['q', 'status', 'userId', 'modelId', 'source', 'from', 'to']);
    const where: Prisma.GenerationJobWhereInput = {
      ...exact(q.q),
      ...dateWhere(q),
      ...(q.userId ? { userId: q.userId } : {}),
      ...(q.status ? { items: { some: { status: q.status } } } : {}),
    };
    if (q.modelId || q.source)
      where.AND = [
        ...(q.modelId ? [{ input: { path: ['modelId'], equals: q.modelId } }] : []),
        ...(q.source ? [{ input: { path: ['source'], equals: q.source } }] : []),
      ];
    const rows = await this.db.client.generationJob.findMany({
      ...pageArgs(q),
      where,
      select: {
        id: true,
        userId: true,
        createdAt: true,
        cancelRequested: true,
        queueDeadlineAt: true,
        deliveryDeadlineAt: true,
        items: { select: { status: true } },
      },
    });
    const meta = rows.length
      ? await this.db.client.$queryRaw<
          Array<{
            id: string;
            model: string | null;
            source: string | null;
            width: string | null;
            height: string | null;
          }>
        >(
          Prisma.sql`SELECT id, input->>'modelId' AS model, input->>'source' AS source, execution->>'width' AS width, execution->>'height' AS height FROM ${this.sqlTable('GenerationJob')} WHERE id IN (${Prisma.join(rows.map((r) => Prisma.sql`${r.id}::uuid`))})`,
        )
      : [];
    return table(
      'Jobs',
      cols(
        'id',
        'userId',
        'modelId',
        'source',
        'status',
        'itemCount',
        'width',
        'height',
        'cancelRequested',
        'createdAt',
      ),
      rows.slice(0, q.limit).map((r) => {
        const m = meta.find((m) => m.id === r.id);
        const modelId = m?.model ?? null;
        return {
          id: r.id,
          userId: r.userId,
          modelId,
          source: m?.source ?? null,
          status: [...new Set(r.items.map((i) => i.status))].join(',') || 'empty',
          itemCount: r.items.length,
          width: m?.width ? Number(m.width) : modelId === 'simulation-image-v1' ? 1024 : null,
          height: m?.height ? Number(m.height) : modelId === 'simulation-image-v1' ? 1024 : null,
          cancelRequested: r.cancelRequested,
          createdAt: r.createdAt.toISOString(),
        };
      }),
      next(rows, q),
      ['A status filter matches jobs containing an item with that status.'],
    );
  }
  async job(actor: AdminActor, jobId: string): Promise<AdminDetail> {
    const row = (await this.jobs(actor, { q: id(jobId) })).rows[0];
    if (!row) throw missing();
    const items = await this.db.client.generationItem.findMany({
      where: { jobId },
      orderBy: { ordinal: 'asc' },
      take: 100,
      select: {
        id: true,
        status: true,
        ordinal: true,
        unitCredits: true,
        resultAssetId: true,
        errorCode: true,
        createdAt: true,
      },
    });
    const attempts = await this.db.client.providerAttempt.findMany({
      where: { item: { jobId } },
      orderBy,
      take: 100,
      select: {
        id: true,
        itemId: true,
        status: true,
        acceptance: true,
        billing: true,
        createdAt: true,
        ...(actor.permissions.includes('costs.read')
          ? {
              estimatedCostMicros: true,
              usage: { select: { actualCostMicros: true, simulated: true, certainty: true } },
            }
          : {}),
      },
    });
    const events = await this.db.client.generationLifecycleEvent.findMany({
      where: { itemId: { in: items.map((i) => i.id) } },
      orderBy,
      take: 100,
      select: { id: true, itemId: true, event: true, createdAt: true },
    });
    const result = detail(
      'Generation job',
      row,
      [
        table(
          'Items',
          cols('id', 'ordinal', 'status', 'unitCredits', 'resultAssetId', 'errorCode', 'createdAt'),
          items.map((i) => ({
            id: i.id,
            ordinal: i.ordinal,
            status: i.status,
            unitCredits: String(i.unitCredits),
            resultAssetId: i.resultAssetId,
            errorCode: i.errorCode,
            createdAt: i.createdAt.toISOString(),
          })),
        ),
        table(
          'Attempts',
          cols(
            'id',
            'itemId',
            'status',
            'acceptance',
            'billing',
            ...(actor.permissions.includes('costs.read')
              ? ['estimatedCostMicros', 'actualCostMicros', 'simulated']
              : []),
            'createdAt',
          ).map((c) => (c.key === 'id' ? { ...c, link: 'attempts' as const } : c)),
          attempts.map((a) => ({
            id: a.id,
            itemId: a.itemId,
            status: a.status,
            acceptance: a.acceptance,
            billing: a.billing,
            ...(actor.permissions.includes('costs.read')
              ? {
                  estimatedCostMicros: String(a.estimatedCostMicros),
                  actualCostMicros: a.usage?.actualCostMicros?.toString() ?? null,
                  simulated: a.usage?.simulated ?? null,
                }
              : {}),
            createdAt: a.createdAt.toISOString(),
          })),
        ),
        table(
          'Lifecycle events',
          cols('id', 'itemId', 'event', 'createdAt'),
          events.map((e) => ({
            id: e.id,
            itemId: e.itemId,
            event: e.event,
            createdAt: e.createdAt.toISOString(),
          })),
        ),
      ],
      ['Historical lifecycle timestamps are unavailable where no event was recorded.'],
    );
    if (actor.permissions.includes('sensitive.read')) {
      const pins = await this.db.client.assetPin.findMany({
        where: { jobId },
        take: 100,
        select: { assetId: true },
      });
      result.sensitive = {
        jobId,
        assetIds: [
          ...new Set([
            ...pins.map((p) => p.assetId),
            ...items.flatMap((i) => (i.resultAssetId ? [i.resultAssetId] : [])),
          ]),
        ],
      };
    }
    return result;
  }
  async attempt(actor: AdminActor, attemptId: string) {
    requirePermission(actor, 'jobs.read');
    const cost = actor.permissions.includes('costs.read');
    const r = await this.db.client.providerAttempt.findUnique({
      where: { id: id(attemptId) },
      select: {
        id: true,
        itemId: true,
        ordinal: true,
        status: true,
        acceptance: true,
        billing: true,
        channelId: true,
        slotActive: true,
        unknownSlot: true,
        createdAt: true,
        item: { select: { jobId: true } },
        ...(cost
          ? {
              estimatedCostMicros: true,
              usage: { select: { actualCostMicros: true, certainty: true, simulated: true } },
            }
          : {}),
      },
    });
    if (!r) throw missing();
    return detail(
      'Provider attempt',
      {
        id: r.id,
        jobId: r.item.jobId,
        itemId: r.itemId,
        ordinal: r.ordinal,
        status: r.status,
        acceptance: r.acceptance,
        billing: r.billing,
        channelId: r.channelId,
        slotActive: r.slotActive,
        unknownSlot: r.unknownSlot,
        ...(cost
          ? {
              estimatedCostMicros: String(r.estimatedCostMicros),
              actualCostMicros: r.usage?.actualCostMicros?.toString() ?? null,
              certainty: r.usage?.certainty ?? 'unknown',
              simulated: r.usage?.simulated ?? null,
            }
          : {}),
        createdAt: r.createdAt.toISOString(),
      },
      [],
      ['Provider payload and request content are excluded.'],
    );
  }
  models(actor: AdminActor, raw: unknown) {
    requirePermission(actor, 'models.read');
    const q = query(raw, ['q', 'status']);
    if (q.status && !['enabled', 'disabled'].includes(q.status)) throw bad();
    const configuredModelIds = new Set([
      ...(this.config.officialImages?.models ?? []).map((model) => model.modelId),
      ...(this.config.thirdPartyImages?.models ?? []).map((model) => model.modelId),
    ]);
    const rows = OFFICIAL_MODELS.map((m) => ({
      id: m.id,
      name: m.name,
      provider: m.provider,
      enabled: configuredModelIds.has(m.id),
      maxImages: m.maxImages,
      verification: '尚未进行线上验证',
      createdAt: new Date(0).toISOString(),
    }))
      .filter(
        (m) => (!q.q || m.id === q.q) && (!q.status || m.enabled === (q.status === 'enabled')),
      )
      .sort((a, b) => b.id.localeCompare(a.id));
    const offset = q.cursorId ? rows.findIndex((r) => r.id === q.cursorId) + 1 : 0;
    if (q.cursorId && offset === 0) throw bad();
    const page = rows.slice(offset, offset + q.limit + 1);
    return table(
      'Models',
      cols('id', 'name', 'provider', 'enabled', 'maxImages', 'verification'),
      page.slice(0, q.limit).map((r) => ({
        id: r.id,
        name: r.name,
        provider: r.provider,
        enabled: r.enabled,
        maxImages: r.maxImages,
        verification: r.verification,
      })),
      next(
        page.map((r) => ({ id: r.id, createdAt: new Date(0) })),
        q,
      ),
      ['Enabled indicates local configuration only; it is not proof of live verification.'],
    );
  }
  async model(actor: AdminActor, modelId: string) {
    const row = this.models(actor, { q: modelId }).rows[0];
    if (!row) throw missing();
    const prices = await this.db.client.modelCreditPrice.findMany({ where: { modelId } });
    return detail(
      'Model definition',
      row,
      [
        table(
          'Output specifications',
          cols('id', 'resolution', 'ratio', 'width', 'height', 'enabled', 'credits'),
          officialSpecs(modelId).map((s) => ({
            id: s.id,
            resolution: s.resolution,
            ratio: s.ratio,
            width: s.width,
            height: s.height,
            enabled: prices.find((p) => p.resolution === s.resolution)?.enabled ?? false,
            credits:
              prices.find((p) => p.resolution === s.resolution)?.unitCredits.toString() ?? null,
          })),
        ),
      ],
      ['Specifications are reviewed product presets. Disabled options have no active sales price.'],
    );
  }
  async providers(actor: AdminActor, raw: unknown) {
    requirePermission(actor, 'providers.read');
    const q = query(raw, ['q']);
    const accounts = new Map<
      string,
      {
        scope: string;
        budgetScope: string;
        provider: string;
        simulated: boolean;
        concurrency: number;
        maxUnknown: number;
        dailyBudgetMicros: bigint;
      }
    >();
    for (const [provider, account] of Object.entries(this.config.officialImages?.accounts ?? {}))
      if (account) {
        const scope = `official-${provider}-${account.scope}`;
        accounts.set(scope, {
          scope,
          budgetScope: `official-usd-${provider}-${account.scope}`,
          provider,
          simulated: false,
          concurrency: account.concurrency,
          maxUnknown: account.maxUnknown,
          dailyBudgetMicros: BigInt(account.dailyBudgetMicros),
        });
      }
    const thirdParty = this.config.thirdPartyChat;
    const thirdPartyImage = this.config.thirdPartyImages;
    if (thirdParty || thirdPartyImage) {
      const account = thirdParty ?? thirdPartyImage!;
      const scope = `third-party-${account.id}-${account.scope}`;
      accounts.set(scope, {
        scope,
        budgetScope: `third-party-usd-${account.id}-${account.scope}`,
        provider: account.id,
        simulated: false,
        concurrency: account.concurrency,
        maxUnknown: account.maxUnknown,
        dailyBudgetMicros: BigInt(account.dailyBudgetMicros),
      });
    }
    if (this.config.simulationProviderEnabled)
      for (const p of SIMULATED_PROFILES)
        accounts.set(p.quotaScope, {
          scope: p.quotaScope,
          budgetScope: p.budgetScope,
          provider: 'simulation',
          simulated: true,
          concurrency: p.concurrency,
          maxUnknown: p.maxUnknown,
          dailyBudgetMicros: p.dailyBudgetMicros,
        });
    const scopes = [...accounts.keys()];
    const [quotas, budgets] = await Promise.all([
      this.db.client.providerQuota.findMany({
        where: { id: { in: scopes } },
        select: { id: true, inflight: true, unknown: true },
      }),
      this.db.client.providerBudget.findMany({
        where: {
          id: { in: [...accounts.values()].map((a) => budgetKey(a.budgetScope, new Date())) },
        },
        select: { id: true, reservedMicros: true, consumedMicros: true },
      }),
    ]);
    const rows = [...accounts.values()]
      .filter((a) => !q.q || a.scope === q.q)
      .sort((a, b) => b.scope.localeCompare(a.scope))
      .map((a) => {
        const quota = quotas.find((x) => x.id === a.scope);
        const budget = budgets.find((x) => x.id === budgetKey(a.budgetScope, new Date()));
        return {
          id: a.scope,
          provider: a.provider,
          simulated: a.simulated,
          concurrency: a.concurrency,
          maxUnknown: a.maxUnknown,
          inflight: quota?.inflight ?? 0,
          unknown: quota?.unknown ?? 0,
          dailyBudgetMicros: String(a.dailyBudgetMicros),
          reservedMicros: String(budget?.reservedMicros ?? 0n),
          consumedMicros: String(budget?.consumedMicros ?? 0n),
          providerBalance: null,
        };
      });
    const offset = q.cursorId ? rows.findIndex((r) => r.id === q.cursorId) + 1 : 0;
    if (q.cursorId && !offset) throw bad();
    const page = rows.slice(offset, offset + q.limit + 1);
    return table(
      'Provider accounts',
      cols(
        'id',
        'provider',
        'simulated',
        'concurrency',
        'maxUnknown',
        'inflight',
        'unknown',
        'dailyBudgetMicros',
        'reservedMicros',
        'consumedMicros',
        'providerBalance',
      ),
      page.slice(0, q.limit),
      next(
        page.map((r) => ({ id: r.id, createdAt: new Date(0) })),
        q,
      ),
      [
        'Budgets are local accounting limits in USD micros, not provider cash balances. Shared scopes are counted once.',
      ],
    );
  }
  async administrators(actor: AdminActor, raw: unknown) {
    requirePermission(actor, 'admins.read');
    const q = query(raw, ['q', 'status', 'from', 'to']);
    const rows = await this.db.client.adminAccount.findMany({
      ...pageArgs(q),
      where: {
        ...exact(q.q, true),
        ...dateWhere(q),
        ...(q.status === 'disabled'
          ? { disabledAt: { not: null } }
          : q.status
            ? { status: q.status, disabledAt: null }
            : {}),
      },
      select: {
        id: true,
        email: true,
        displayName: true,
        status: true,
        roleBindings: { include: { role: true } },
        disabledAt: true,
        createdAt: true,
      },
    });
    return table(
      'Administrators',
      cols('id', 'email', 'displayName', 'status', 'roles', 'createdAt'),
      rows.slice(0, q.limit).map((r) => ({
        id: r.id,
        email: maskEmail(r.email),
        displayName: r.displayName,
        status: r.disabledAt ? 'disabled' : r.status,
        roles: r.roleBindings
          .filter((b) => !b.role.deletedAt)
          .map((b) => b.roleKey)
          .join(', '),
        createdAt: r.createdAt.toISOString(),
      })),
      next(rows, q),
    );
  }
  async roles(actor: AdminActor, raw: unknown) {
    requirePermission(actor, 'admins.read');
    const q = query(raw, ['q']);
    const rows = (
      await this.db.client.adminRole.findMany({
        where: { deletedAt: null, ...(q.q ? { key: q.q } : {}) },
        orderBy: { key: 'desc' },
      })
    ).map((r) => ({ id: r.key, permissions: r.permissions.join(', ') }));
    const offset = q.cursorId ? rows.findIndex((r) => r.id === q.cursorId) + 1 : 0;
    if (q.cursorId && !offset) throw bad();
    const page = rows.slice(offset, offset + q.limit + 1);
    return table(
      'Roles',
      cols('id', 'permissions'),
      page.slice(0, q.limit),
      next(
        page.map((r) => ({ id: r.id, createdAt: new Date(0) })),
        q,
      ),
      ['敏感读取仍需独立授权；角色编辑请使用团队角色管理。'],
    );
  }
  async auditEvents(actor: AdminActor, raw: unknown) {
    requirePermission(actor, 'audit.read');
    const q = query(raw, ['q', 'from', 'to', 'status']);
    const rows = await this.db.client.adminAuditEvent.findMany({
      ...pageArgs(q),
      where: { ...exact(q.q), ...dateWhere(q), ...(q.status ? { outcome: q.status } : {}) },
      select: {
        id: true,
        accountId: true,
        action: true,
        resourceId: true,
        outcome: true,
        createdAt: true,
      },
    });
    return table(
      'Audit events',
      cols('id', 'accountId', 'action', 'resourceId', 'outcome', 'createdAt'),
      rows.slice(0, q.limit).map((r) => ({
        id: r.id,
        accountId: r.accountId,
        action: r.action,
        resourceId: r.resourceId,
        outcome: r.outcome,
        createdAt: r.createdAt.toISOString(),
      })),
      next(rows, q),
    );
  }
  async alerts(actor: AdminActor, raw: unknown) {
    requirePermission(actor, 'alerts.read');
    const q = query(raw, ['q', 'from', 'to', 'status', 'source']);
    if (q.status && !['active', 'resolved'].includes(q.status)) throw bad();
    await this.refreshAlerts();
    const categories = ['service', 'model', 'content'].filter((category) =>
      actor.permissions.includes(`alerts.${category}.read`),
    );
    const rows = await this.db.client.adminAlert.findMany({
      ...pageArgs(q),
      where: {
        ...exact(q.q),
        ...dateWhere(q),
        category: { in: categories },
        ...(q.status ? { resolved: q.status === 'resolved' } : {}),
        ...(q.source ? { kind: q.source } : {}),
      },
      select: {
        id: true,
        category: true,
        kind: true,
        resourceId: true,
        firstSeenAt: true,
        lastSeenAt: true,
        resolved: true,
        createdAt: true,
      },
    });
    return table(
      'Alerts',
      cols(
        'id',
        'category',
        'kind',
        'resourceId',
        'jobId',
        'attemptId',
        'contentMediaId',
        'firstSeenAt',
        'lastSeenAt',
        'resolved',
      ),
      rows.slice(0, q.limit).map((r) => ({
        id: r.id,
        category: r.category,
        kind: r.kind,
        resourceId: r.resourceId,
        jobId: r.category === 'service' ? r.resourceId : null,
        attemptId: r.kind === 'unknown_attempt' ? r.resourceId : null,
        contentMediaId: r.category === 'content' ? r.resourceId : null,
        firstSeenAt: r.firstSeenAt.toISOString(),
        lastSeenAt: r.lastSeenAt.toISOString(),
        resolved: r.resolved,
      })),
      next(rows, q),
      ['Alert rules and notifications are unavailable in increment A.'],
    );
  }
  private async refreshAlerts() {
    // A single projection lock serializes scans and resolution; business rows are read only.
    await this.db.transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('admin:alert-projection',0))`;
      const schema = new URL(this.config.databaseUrl).searchParams.get('schema') ?? 'public';
      await tx.$executeRaw`SELECT set_config('search_path', ${`"${schema.replaceAll('"', '""')}"`}, true)`;
      const now = new Date();
      // INSERT SELECT keeps projection refresh bounded in memory and never copies raw payloads.
      await tx.$executeRaw`INSERT INTO "AdminAlert" (id,"sourceKey",category,kind,"resourceId","firstSeenAt","lastSeenAt",resolved,"createdAt") SELECT gen_random_uuid(), 'unknown:' || id::text, 'model', 'unknown_attempt', id::text, ${now}, ${now}, false, ${now} FROM "ProviderAttempt" WHERE "slotActive" AND ("unknownSlot" OR status='unknown') ON CONFLICT ("sourceKey") DO UPDATE SET "lastSeenAt"=EXCLUDED."lastSeenAt", resolved=false`;
      await tx.$executeRaw`INSERT INTO "AdminAlert" (id,"sourceKey",category,kind,"resourceId","firstSeenAt","lastSeenAt",resolved,"createdAt") SELECT gen_random_uuid(), 'overdue:' || r.id::text, 'service', 'overdue_reservation', r."jobId"::text, ${now}, ${now}, false, ${now} FROM "CreditReservation" r JOIN "GenerationJob" j ON j.id=r."jobId" WHERE r.status='held' AND j."deliveryDeadlineAt" < ${now} ON CONFLICT ("sourceKey") DO UPDATE SET "lastSeenAt"=EXCLUDED."lastSeenAt", resolved=false`;
      await tx.$executeRaw`INSERT INTO "AdminAlert" (id,"sourceKey",category,kind,"resourceId","firstSeenAt","lastSeenAt",resolved,"createdAt") SELECT gen_random_uuid(), 'materialization:' || i.id::text, 'service', 'missing_materialization', i."jobId"::text, ${now}, ${now}, false, ${now} FROM "GenerationItem" i LEFT JOIN assets a ON a.id=i."resultAssetId" WHERE (i.status='succeeded' AND (a.id IS NULL OR a.status <> 'ready' OR a.deleted_at IS NOT NULL)) OR (i.status='materializing' AND i."nextRunAt" < ${now} AND (i."leaseUntil" IS NULL OR i."leaseUntil" < ${now})) ON CONFLICT ("sourceKey") DO UPDATE SET "lastSeenAt"=EXCLUDED."lastSeenAt", resolved=false`;
      const scopeLimits = new Map<string, bigint>();
      for (const [provider, a] of Object.entries(this.config.officialImages?.accounts ?? {}))
        if (a) scopeLimits.set(`official-usd-${provider}-${a.scope}`, BigInt(a.dailyBudgetMicros));
      if (this.config.simulationProviderEnabled)
        for (const p of SIMULATED_PROFILES) scopeLimits.set(p.budgetScope, p.dailyBudgetMicros);
      for (const [scope, limit] of scopeLimits) {
        const key = budgetKey(scope, now);
        const b = await tx.providerBudget.findUnique({
          where: { id: key },
          select: { reservedMicros: true, consumedMicros: true },
        });
        if (b && (b.reservedMicros + b.consumedMicros) * 100n >= limit * 80n)
          await tx.adminAlert.upsert({
            where: { sourceKey: `budget:${key}` },
            create: {
              sourceKey: `budget:${key}`,
              category: 'model',
              kind: 'budget_80_percent',
              resourceId: scope,
              firstSeenAt: now,
              lastSeenAt: now,
              createdAt: now,
            },
            update: { lastSeenAt: now, resolved: false },
          });
      }
      await tx.adminAlert.updateMany({
        where: {
          category: { in: ['service', 'model'] },
          resolved: false,
          lastSeenAt: { lt: now },
        },
        data: { resolved: true },
      });
    });
  }
  async dashboard(actor: AdminActor, raw: unknown): Promise<Dashboard> {
    requirePermission(actor, 'dashboard.read');
    parse(z.object({}).strict(), raw);
    const metrics: Dashboard['metrics'] = [];
    const notices = ['团队管理 B1 已开放；本页业务指标及其他业务资源仍为只读。'];
    if (
      ['dashboard.business.read', 'users.read', 'orders.read', 'jobs.read'].every((p) =>
        actor.permissions.includes(p),
      )
    ) {
      const [users, orders, jobs] = await Promise.all([
        this.db.client.user.count(),
        this.db.client.paymentOrder.count(),
        this.db.client.generationJob.count(),
      ]);
      metrics.push(
        {
          key: 'users',
          label: 'Users',
          value: String(users),
          note: 'Registered customers',
          href: '/users',
        },
        {
          key: 'orders',
          label: 'Orders',
          value: String(orders),
          note: 'All payment orders',
          href: '/orders',
        },
        {
          key: 'jobs',
          label: 'Jobs',
          value: String(jobs),
          note: 'All generation jobs',
          href: '/jobs',
        },
      );
    }
    if (
      ['dashboard.finance.read', 'orders.read', 'credits.read'].every((p) =>
        actor.permissions.includes(p),
      )
    ) {
      const [paid, credits] = await Promise.all([
        this.db.client.paymentOrder.aggregate({
          where: { status: { in: ['paid', 'fulfilled'] } },
          _sum: { amountMinor: true },
        }),
        this.db.client.creditLot.aggregate({
          _sum: { available: true, held: true, consumed: true },
        }),
      ]);
      metrics.push(
        {
          key: 'paid',
          label: 'Paid order amount',
          kind: 'cny',
          value: String(paid._sum.amountMinor ?? 0),
          note: 'Recorded paid/fulfilled orders; CNY minor units',
        },
        {
          key: 'availableCredits',
          label: 'Available credits',
          kind: 'credits',
          value: String(credits._sum.available ?? 0n),
          note: 'Ledger lot sum',
        },
        {
          key: 'heldCredits',
          label: 'Held credits',
          kind: 'credits',
          value: String(credits._sum.held ?? 0n),
          note: 'Ledger lot sum',
        },
        {
          key: 'refunds',
          label: 'Cash refunds',
          kind: 'cny',
          value: null,
          note: 'Unavailable: cash refund workflow is not integrated',
        },
        {
          key: 'fees',
          label: 'Payment fees',
          kind: 'cny',
          value: null,
          note: 'Unavailable: provider fees are not recorded',
        },
        {
          key: 'profit',
          label: 'Net profit',
          kind: 'cny',
          value: null,
          note: 'Unavailable: currencies, fees and refunds cannot be reconciled',
        },
      );
    }
    if (
      actor.permissions.includes('costs.read') &&
      [
        ['dashboard.finance.read', 'orders.read', 'credits.read'],
        ['dashboard.models.read', 'models.read'],
      ].some((group) => group.every((p) => actor.permissions.includes(p)))
    )
      for (const simulated of [false, true]) {
        const [usage, unknown] = await Promise.all([
          this.db.client.providerUsageRecord.aggregate({
            where: { simulated },
            _sum: { actualCostMicros: true },
          }),
          this.db.client.providerUsageRecord.count({
            where: { simulated, actualCostMicros: null },
          }),
        ]);
        metrics.push({
          key: simulated ? 'simulatedCost' : 'realCost',
          label: simulated ? 'Simulated cost' : 'Real provider cost',
          kind: 'usd',
          value: unknown ? null : String(usage._sum.actualCostMicros ?? 0n),
          note: unknown
            ? `${unknown} attempt costs remain unknown`
            : 'Recorded USD micros; simulation is separate',
        });
      }
    if (['dashboard.models.read', 'models.read'].every((p) => actor.permissions.includes(p))) {
      const enabled = new Set([
        ...(this.config.officialImages?.models ?? []).map((model) => model.modelId),
        ...(this.config.thirdPartyImages?.models ?? []).map((model) => model.modelId),
      ]).size;
      metrics.push({
        key: 'enabledModels',
        label: 'Configured models',
        value: String(enabled),
        note: 'Local configuration; live verification not performed',
        href: '/models',
      });
    }
    if (['dashboard.system.read', 'admins.read'].every((p) => actor.permissions.includes(p)))
      metrics.push({
        key: 'administrators',
        label: 'Administrators',
        value: String(await this.db.client.adminAccount.count()),
        note: 'All administrator records',
        href: '/administrators',
      });
    if (actor.permissions.includes('dashboard.content.read'))
      notices.push('Content operations are not integrated.');
    const alerts = actor.permissions.includes('alerts.read')
      ? await this.alerts(actor, { status: 'active', limit: '30' })
      : table('Alerts', [], [], null, ['No alert category is available to this role.']);
    return {
      asOf: new Date().toISOString(),
      environment: this.config.nodeEnv,
      metrics: metrics.map((m) => ({ ...m, label: label(m.label), note: label(m.note) })),
      alerts,
      notices: notices.map(label),
    };
  }
}
