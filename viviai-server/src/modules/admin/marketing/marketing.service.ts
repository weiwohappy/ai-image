import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Prisma } from '../../../generated/prisma/client.js';
import type { AppConfig } from '../../../config.js';
import { DatabaseService, type DbTransaction } from '../../../shared/database/database.service.js';
import { AppError } from '../../../shared/http/errors.js';
import { APP_CONFIG } from '../../../shared/infrastructure.module.js';
import { AdminAuthService, lockAdmin, type AdminContext } from '../auth.service.js';
import { AdminAuditService, type AuditMetadata } from '../audit.service.js';
import { adminCommandReceiptLockKey } from '../command-receipt.js';
import { digest } from '../crypto.js';
import { requirePermission } from '../permissions.js';
import { failure, teamWritesEnabled } from '../team/policy.js';

type MarketingResult = { resourceId: string; [key: string]: unknown };
type CampaignStatus = 'active' | 'disabled' | 'archived';
type PageKind = 'campaigns' | 'codes' | 'claims' | 'referrals';

const reasonSchema = z.string().trim().min(5).max(500);
const versionSchema = z.number().int().min(1).max(2_147_483_647);
const campaignFieldsSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }),
    perUserLimit: z.number().int().min(1).max(1_000_000),
    credits: z.number().int().min(1).max(1_000_000_000),
    totalLimit: z.number().int().min(1).max(1_000_000_000).nullable(),
  })
  .strict()
  .refine((input) => input.startsAt < input.endsAt, { path: ['endsAt'] });
const createCampaignSchema = campaignFieldsSchema.extend({ reason: reasonSchema }).strict();
const updateCampaignSchema = campaignFieldsSchema
  .extend({ version: versionSchema, reason: reasonSchema })
  .strict();
const transitionSchema = z.object({ version: versionSchema, reason: reasonSchema }).strict();
const codeBatchSchema = z
  .object({
    campaignId: z.uuid(),
    campaignVersion: versionSchema,
    quantity: z.number().int().min(1).max(1_000),
    maxUses: z.number().int().min(1).max(1_000_000),
    reason: reasonSchema,
  })
  .strict();
const campaignListSchema = z
  .object({
    status: z.enum(['active', 'disabled', 'archived']).optional(),
    q: z.string().trim().min(1).max(120).optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    cursor: z.string().min(1).max(2048).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(30),
  })
  .strict()
  .refine((input) => !input.from || !input.to || input.from <= input.to, { path: ['from'] });
const codeListSchema = z
  .object({
    campaignId: z.uuid().optional(),
    status: z.enum(['active', 'disabled']).optional(),
    q: z.string().trim().min(1).max(120).optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    cursor: z.string().min(1).max(2048).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(30),
  })
  .strict()
  .refine((input) => !input.from || !input.to || input.from <= input.to, { path: ['from'] });
const claimListSchema = z
  .object({
    campaignId: z.uuid().optional(),
    codeId: z.uuid().optional(),
    userId: z.uuid().optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    cursor: z.string().min(1).max(2048).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(30),
  })
  .strict()
  .refine((input) => !input.from || !input.to || input.from <= input.to, { path: ['from'] });
const referralListSchema = z
  .object({
    status: z.enum(['pending', 'rewarded']).optional(),
    userId: z.uuid().optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    cursor: z.string().min(1).max(2048).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(30),
  })
  .strict()
  .refine((input) => !input.from || !input.to || input.from <= input.to, { path: ['from'] });

const cursorSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(['campaigns', 'codes', 'claims', 'referrals']),
    filter: z.string().max(2048),
    at: z.iso.datetime(),
    id: z.uuid(),
    mac: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
type Cursor = z.infer<typeof cursorSchema>;

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw failure(400, 'ADMIN_INVALID_INPUT', 'Invalid administrator request');
  return result.data;
}

function mutationId(value: string): string {
  if (!z.uuid().safeParse(value).success)
    throw failure(400, 'ADMIN_INVALID_INPUT', 'Invalid administrator request');
  return value;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonical(nested)]),
    );
  return value;
}

function requestDigest(action: string, target: string, input: Record<string, unknown>): string {
  return digest(JSON.stringify(canonical({ action, target, input })));
}

async function lockMarketing(tx: DbTransaction, key: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

function filter(value: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).filter(([, nested]) => nested !== undefined)),
  );
}

function cursorMac(payload: Omit<Cursor, 'mac'>, secret: string): string {
  return createHmac('sha256', secret)
    .update(`admin-marketing-cursor-v1:${JSON.stringify(payload)}`)
    .digest('hex');
}

function invalidCursor(): never {
  throw failure(400, 'ADMIN_INVALID_INPUT', 'Invalid pagination cursor');
}

function decodeCursor(
  value: string | undefined,
  kind: PageKind,
  queryFilter: string,
  secret: string,
): { at: Date; id: string } | undefined {
  if (!value) return undefined;
  if (!/^[A-Za-z0-9_-]{1,2048}$/.test(value)) return invalidCursor();
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) return invalidCursor();
    const parsed = cursorSchema.parse(JSON.parse(bytes.toString('utf8')));
    const { mac, ...payload } = parsed;
    const expected = cursorMac(payload, secret);
    if (
      parsed.kind !== kind ||
      parsed.filter !== queryFilter ||
      !timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(expected, 'hex'))
    )
      return invalidCursor();
    return { at: new Date(parsed.at), id: parsed.id };
  } catch {
    return invalidCursor();
  }
}

function nextCursor(
  rows: Array<{ id: string }>,
  limit: number,
  kind: PageKind,
  queryFilter: string,
  secret: string,
  at: (row: { id: string }) => Date,
): string | null {
  if (rows.length <= limit) return null;
  const last = rows[limit - 1];
  if (!last) return null;
  const payload = {
    version: 1 as const,
    kind,
    filter: queryFilter,
    at: at(last).toISOString(),
    id: last.id,
  };
  return Buffer.from(JSON.stringify({ ...payload, mac: cursorMac(payload, secret) })).toString(
    'base64url',
  );
}

function descendingAfter(anchor: { at: Date; id: string } | undefined, field: string) {
  return anchor
    ? {
        AND: [
          {
            OR: [{ [field]: { lt: anchor.at } }, { [field]: anchor.at, id: { lt: anchor.id } }],
          },
        ],
      }
    : {};
}

function dateWhere(from?: string, to?: string) {
  return from || to
    ? {
        createdAt: {
          ...(from ? { gte: new Date(from) } : {}),
          ...(to ? { lte: new Date(to) } : {}),
        },
      }
    : {};
}

function maskEmail(email: string): string {
  const [name, domain] = email.split('@');
  return `${name?.slice(0, 1) ?? ''}***@${domain ?? '***'}`;
}

@Injectable()
export class AdminMarketingCommands {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AdminAuthService) private readonly auth: AdminAuthService,
    @Inject(AdminAuditService) private readonly audit: AdminAuditService,
  ) {}

  async run<T extends MarketingResult>(
    context: AdminContext,
    key: string,
    action: string,
    target: string,
    input: { reason: string; [key: string]: unknown },
    permissions: string[],
    work: (
      tx: DbTransaction,
      current: AdminContext,
    ) => Promise<{ result: T; receiptResult?: MarketingResult; metadata?: AuditMetadata }>,
  ): Promise<T | MarketingResult> {
    if (!z.uuid().safeParse(key).success)
      throw failure(400, 'ADMIN_INVALID_INPUT', '需要有效幂等键');
    const commandDigest = requestDigest(action, target, input);
    try {
      return await this.db.withSessionAdvisoryLock(
        adminCommandReceiptLockKey(context.actor.id, key),
        30_000,
        () =>
          this.db.transaction(async (tx) => {
            await lockAdmin(tx, context.actor.id);
            const current = await this.auth.reauthorize(
              tx,
              context.sessionId,
              context.actor.id,
              context.requestIp ?? 'unknown',
            );
            if (!teamWritesEnabled(this.config, current.requestIp))
              throw failure(503, 'ADMIN_TEAM_WRITES_DISABLED', '营销写入仅在本机开发环境开放');
            for (const permission of permissions) requirePermission(current.actor, permission);
            const receipt = await tx.adminCommandReceipt.findUnique({
              where: {
                accountId_idempotencyKey: {
                  accountId: current.actor.id,
                  idempotencyKey: key,
                },
              },
            });
            if (receipt) {
              if (
                receipt.action !== action ||
                receipt.target !== target ||
                receipt.requestDigest !== commandDigest
              )
                throw failure(409, 'ADMIN_IDEMPOTENCY_CONFLICT', '幂等键已用于其他请求');
              return receipt.result as unknown as MarketingResult;
            }
            const { result, receiptResult, metadata } = await work(tx, current);
            await this.audit.write(
              tx,
              action,
              'allowed',
              current.actor.id,
              current.sessionId,
              result.resourceId,
              digest(input.reason),
              metadata,
            );
            await tx.adminCommandReceipt.create({
              data: {
                accountId: current.actor.id,
                sessionId: current.sessionId,
                idempotencyKey: key,
                action,
                target,
                requestDigest: commandDigest,
                result: (receiptResult ?? result) as Prisma.InputJsonObject,
              },
            });
            return result;
          }),
      );
    } catch (error) {
      if (error instanceof AppError && [403, 409, 422].includes(error.status)) {
        await this.db.transaction(async (tx) => {
          await lockAdmin(tx, `marketing-denied:${context.actor.id}:${action}:${target}`);
          const recent = await tx.adminAuditEvent.findFirst({
            where: {
              accountId: context.actor.id,
              action,
              resourceId: target,
              outcome: 'denied',
              createdAt: { gt: new Date(Date.now() - 600_000) },
            },
          });
          if (!recent)
            await this.audit.write(
              tx,
              action,
              'denied',
              context.actor.id,
              context.sessionId,
              target,
              digest(input.reason),
              { code: error.code },
            );
        });
      }
      throw error;
    }
  }
}

@Injectable()
export class AdminMarketingService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AdminMarketingCommands) private readonly commands: AdminMarketingCommands,
  ) {}

  async listCampaigns(context: AdminContext, raw: unknown) {
    requirePermission(context.actor, 'redemptions.read');
    const query = parse(campaignListSchema, raw);
    const queryFilter = filter({
      status: query.status,
      q: query.q,
      from: query.from,
      to: query.to,
    });
    const anchor = decodeCursor(
      query.cursor,
      'campaigns',
      queryFilter,
      this.config.contentCursorSecret,
    );
    const rows = await this.db.client.redemptionCampaign.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.q ? { name: { contains: query.q, mode: 'insensitive' as const } } : {}),
        ...(query.from || query.to
          ? {
              updatedAt: {
                ...(query.from ? { gte: new Date(query.from) } : {}),
                ...(query.to ? { lte: new Date(query.to) } : {}),
              },
            }
          : {}),
        ...descendingAfter(anchor, 'updatedAt'),
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    return {
      rows: rows.slice(0, query.limit).map((row) => this.campaignDto(row)),
      nextCursor: nextCursor(
        rows,
        query.limit,
        'campaigns',
        queryFilter,
        this.config.contentCursorSecret,
        (row) => (row as (typeof rows)[number]).updatedAt,
      ),
    };
  }

  async campaign(context: AdminContext, id: string) {
    requirePermission(context.actor, 'redemptions.read');
    mutationId(id);
    const row = await this.db.client.redemptionCampaign.findUnique({
      where: { id },
      include: { _count: { select: { codes: true } } },
    });
    if (!row) throw failure(404, 'REDEMPTION_CAMPAIGN_NOT_FOUND', '兑换活动不存在');
    return { ...this.campaignDto(row), codeCount: row._count.codes };
  }

  async createCampaign(context: AdminContext, key: string, raw: unknown) {
    const input = parse(createCampaignSchema, raw);
    return this.commands.run(
      context,
      key,
      'redemptions.campaign.create',
      'new',
      input,
      ['redemptions.read', 'redemptions.write'],
      async (tx) => {
        await lockMarketing(tx, 'redemption:campaign:create');
        if (new Date(input.endsAt) <= new Date())
          throw failure(422, 'REDEMPTION_CAMPAIGN_UNAVAILABLE', '兑换活动已过期');
        const row = await tx.redemptionCampaign.create({
          data: {
            name: input.name,
            startsAt: new Date(input.startsAt),
            endsAt: new Date(input.endsAt),
            perUserLimit: input.perUserLimit,
            credits: input.credits,
            totalLimit: input.totalLimit,
            status: 'active',
          },
        });
        return {
          result: this.campaignDto(row),
          metadata: {
            changedFields: [
              'name',
              'startsAt',
              'endsAt',
              'perUserLimit',
              'credits',
              'totalLimit',
              'status',
            ],
            afterStatus: 'active',
            afterVersion: 1,
          },
        };
      },
    );
  }

  async updateCampaign(context: AdminContext, key: string, id: string, raw: unknown) {
    mutationId(id);
    const input = parse(updateCampaignSchema, raw);
    return this.commands.run(
      context,
      key,
      'redemptions.campaign.update',
      id,
      input,
      ['redemptions.read', 'redemptions.write'],
      async (tx) => {
        await lockMarketing(tx, `redemption:campaign:${id}`);
        const before = await tx.redemptionCampaign.findUnique({ where: { id } });
        if (!before) throw failure(404, 'REDEMPTION_CAMPAIGN_NOT_FOUND', '兑换活动不存在');
        this.version(before.version, input.version);
        if (new Date(input.endsAt) <= new Date())
          throw failure(422, 'REDEMPTION_CAMPAIGN_UNAVAILABLE', '兑换活动已过期');
        if (before.status === 'archived')
          throw failure(422, 'REDEMPTION_INVALID_TRANSITION', '归档活动不可编辑');
        const data = {
          name: input.name,
          startsAt: new Date(input.startsAt),
          endsAt: new Date(input.endsAt),
          perUserLimit: input.perUserLimit,
          credits: input.credits,
          totalLimit: input.totalLimit,
        };
        const changedFields = Object.entries(data)
          .filter(
            ([field, value]) => !isDeepStrictEqual(before[field as keyof typeof before], value),
          )
          .map(([field]) => field);
        if (!changedFields.length) return { result: this.campaignDto(before) };
        const row = await tx.redemptionCampaign.update({
          where: { id },
          data: { ...data, version: { increment: 1 } },
        });
        return {
          result: this.campaignDto(row),
          metadata: {
            changedFields,
            beforeStatus: before.status,
            afterStatus: row.status,
            beforeVersion: before.version,
            afterVersion: row.version,
          },
        };
      },
    );
  }

  disableCampaign(context: AdminContext, key: string, id: string, raw: unknown) {
    return this.transitionCampaign(context, key, id, raw, 'disabled');
  }

  archiveCampaign(context: AdminContext, key: string, id: string, raw: unknown) {
    return this.transitionCampaign(context, key, id, raw, 'archived');
  }

  private async transitionCampaign(
    context: AdminContext,
    key: string,
    id: string,
    raw: unknown,
    status: Exclude<CampaignStatus, 'active'>,
  ) {
    mutationId(id);
    const input = parse(transitionSchema, raw);
    return this.commands.run(
      context,
      key,
      `redemptions.campaign.${status === 'disabled' ? 'disable' : 'archive'}`,
      id,
      input,
      ['redemptions.read', 'redemptions.write'],
      async (tx) => {
        await lockMarketing(tx, `redemption:campaign:${id}`);
        const before = await tx.redemptionCampaign.findUnique({ where: { id } });
        if (!before) throw failure(404, 'REDEMPTION_CAMPAIGN_NOT_FOUND', '兑换活动不存在');
        this.version(before.version, input.version);
        const valid =
          (status === 'disabled' && before.status === 'active') ||
          (status === 'archived' && ['active', 'disabled'].includes(before.status));
        if (!valid) throw failure(422, 'REDEMPTION_INVALID_TRANSITION', '无效兑换活动状态转换');
        const row = await tx.redemptionCampaign.update({
          where: { id },
          data: { status, version: { increment: 1 } },
        });
        return {
          result: this.campaignDto(row),
          metadata: {
            changedFields: ['status'],
            beforeStatus: before.status,
            afterStatus: row.status,
            beforeVersion: before.version,
            afterVersion: row.version,
          },
        };
      },
    );
  }

  async generateCodes(context: AdminContext, key: string, raw: unknown) {
    const input = parse(codeBatchSchema, raw);
    return this.commands.run(
      context,
      key,
      'redemptions.codes.generate',
      input.campaignId,
      input,
      ['redemptions.read', 'redemptions.write'],
      async (tx) => {
        await lockMarketing(tx, `redemption:campaign:${input.campaignId}`);
        await lockMarketing(tx, 'redemption:code-generation');
        const campaign = await tx.redemptionCampaign.findUnique({
          where: { id: input.campaignId },
        });
        if (!campaign) throw failure(404, 'REDEMPTION_CAMPAIGN_NOT_FOUND', '兑换活动不存在');
        this.version(campaign.version, input.campaignVersion);
        if (campaign.status !== 'active' || campaign.endsAt <= new Date())
          throw failure(422, 'REDEMPTION_CAMPAIGN_UNAVAILABLE', '兑换活动不可用');
        if (campaign.totalLimit !== null && input.quantity * input.maxUses > campaign.totalLimit)
          throw failure(422, 'REDEMPTION_CAMPAIGN_LIMIT_EXCEEDED', '兑换码容量超过活动上限');
        const generated = await this.uniqueCodes(tx, input.quantity);
        await tx.redemptionCode.createMany({
          data: generated.map((item) => ({
            campaignId: campaign.id,
            digest: item.digest,
            displayMask: item.displayMask,
            maxUses: input.maxUses,
          })),
        });
        const rows = await tx.redemptionCode.findMany({
          where: { digest: { in: generated.map((item) => item.digest) } },
        });
        const byDigest = new Map(rows.map((row) => [row.digest, row]));
        const codes = generated.map((item) => {
          const row = byDigest.get(item.digest)!;
          return { ...this.codeDto(row), code: item.code };
        });
        const safe = {
          resourceId: campaign.id,
          campaignId: campaign.id,
          generated: rows.length,
          codeIds: rows.map((row) => row.id).sort(),
          codesUnavailable: true,
        };
        return {
          result: {
            resourceId: campaign.id,
            campaignId: campaign.id,
            generated: codes.length,
            codes,
          },
          receiptResult: safe,
          metadata: { itemCount: codes.length },
        };
      },
    );
  }

  async listCodes(context: AdminContext, raw: unknown) {
    requirePermission(context.actor, 'redemptions.read');
    const query = parse(codeListSchema, raw);
    const queryFilter = filter({
      campaignId: query.campaignId,
      status: query.status,
      q: query.q,
      from: query.from,
      to: query.to,
    });
    const anchor = decodeCursor(
      query.cursor,
      'codes',
      queryFilter,
      this.config.contentCursorSecret,
    );
    const rows = await this.db.client.redemptionCode.findMany({
      where: {
        ...(query.campaignId ? { campaignId: query.campaignId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.q ? { displayMask: { contains: query.q, mode: 'insensitive' as const } } : {}),
        ...dateWhere(query.from, query.to),
        ...descendingAfter(anchor, 'createdAt'),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    return {
      rows: rows.slice(0, query.limit).map((row) => this.codeDto(row)),
      nextCursor: nextCursor(
        rows,
        query.limit,
        'codes',
        queryFilter,
        this.config.contentCursorSecret,
        (row) => (row as (typeof rows)[number]).createdAt,
      ),
    };
  }

  async code(context: AdminContext, id: string) {
    requirePermission(context.actor, 'redemptions.read');
    mutationId(id);
    const row = await this.db.client.redemptionCode.findUnique({ where: { id } });
    if (!row) throw failure(404, 'REDEMPTION_CODE_NOT_FOUND', '兑换码不存在');
    return this.codeDto(row);
  }

  async disableCode(context: AdminContext, key: string, id: string, raw: unknown) {
    mutationId(id);
    const input = parse(transitionSchema, raw);
    return this.commands.run(
      context,
      key,
      'redemptions.code.disable',
      id,
      input,
      ['redemptions.read', 'redemptions.write'],
      async (tx) => {
        const observed = await tx.redemptionCode.findUnique({ where: { id } });
        if (!observed) throw failure(404, 'REDEMPTION_CODE_NOT_FOUND', '兑换码不存在');
        await lockMarketing(tx, `redemption:code:${observed.digest}`);
        await lockMarketing(tx, `redemption:campaign:${observed.campaignId}`);
        const before = await tx.redemptionCode.findUnique({ where: { id } });
        if (!before) throw failure(404, 'REDEMPTION_CODE_NOT_FOUND', '兑换码不存在');
        this.version(before.version, input.version);
        if (before.status !== 'active')
          throw failure(422, 'REDEMPTION_INVALID_TRANSITION', '兑换码已禁用');
        const row = await tx.redemptionCode.update({
          where: { id },
          data: { status: 'disabled', version: { increment: 1 } },
        });
        return {
          result: this.codeDto(row),
          metadata: {
            changedFields: ['status'],
            beforeStatus: before.status,
            afterStatus: row.status,
            beforeVersion: before.version,
            afterVersion: row.version,
          },
        };
      },
    );
  }

  async listClaims(context: AdminContext, raw: unknown) {
    requirePermission(context.actor, 'redemptions.read');
    const query = parse(claimListSchema, raw);
    const queryFilter = filter({
      campaignId: query.campaignId,
      codeId: query.codeId,
      userId: query.userId,
      from: query.from,
      to: query.to,
    });
    const anchor = decodeCursor(
      query.cursor,
      'claims',
      queryFilter,
      this.config.contentCursorSecret,
    );
    const rows = await this.db.client.redemptionClaim.findMany({
      where: {
        ...(query.userId ? { userId: query.userId } : {}),
        ...(query.codeId || query.campaignId
          ? {
              code: {
                ...(query.codeId ? { id: query.codeId } : {}),
                ...(query.campaignId ? { campaignId: query.campaignId } : {}),
              },
            }
          : {}),
        ...dateWhere(query.from, query.to),
        ...descendingAfter(anchor, 'createdAt'),
      },
      include: {
        user: { select: { id: true, email: true } },
        code: {
          select: {
            id: true,
            displayMask: true,
            campaign: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    return {
      rows: rows.slice(0, query.limit).map((row) => ({
        id: row.id,
        userId: row.user.id,
        userEmail: maskEmail(row.user.email),
        codeId: row.code.id,
        codeMask: row.code.displayMask,
        campaignId: row.code.campaign.id,
        campaignName: row.code.campaign.name,
        credits: row.credits,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: nextCursor(
        rows,
        query.limit,
        'claims',
        queryFilter,
        this.config.contentCursorSecret,
        (row) => (row as (typeof rows)[number]).createdAt,
      ),
    };
  }

  async listReferrals(context: AdminContext, raw: unknown) {
    requirePermission(context.actor, 'referrals.read');
    const query = parse(referralListSchema, raw);
    const queryFilter = filter({
      status: query.status,
      userId: query.userId,
      from: query.from,
      to: query.to,
    });
    const anchor = decodeCursor(
      query.cursor,
      'referrals',
      queryFilter,
      this.config.contentCursorSecret,
    );
    const rows = await this.db.client.referral.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.userId
          ? { OR: [{ inviterUserId: query.userId }, { inviteeUserId: query.userId }] }
          : {}),
        ...dateWhere(query.from, query.to),
        ...descendingAfter(anchor, 'createdAt'),
      },
      include: {
        inviter: { select: { id: true, email: true } },
        invitee: { select: { id: true, email: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    return {
      rows: rows.slice(0, query.limit).map((row) => ({
        id: row.id,
        inviterUserId: row.inviter.id,
        inviterEmail: maskEmail(row.inviter.email),
        inviteeUserId: row.invitee.id,
        inviteeEmail: maskEmail(row.invitee.email),
        status: row.status === 'rewarded' ? 'rewarded' : 'pending',
        rewardCredits: row.rewardCredits,
        qualifiedAt: row.qualifiedAt?.toISOString() ?? null,
        rewardedAt: row.rewardedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: nextCursor(
        rows,
        query.limit,
        'referrals',
        queryFilter,
        this.config.contentCursorSecret,
        (row) => (row as (typeof rows)[number]).createdAt,
      ),
    };
  }

  private async uniqueCodes(tx: DbTransaction, quantity: number) {
    const generated = new Map<string, { code: string; digest: string; displayMask: string }>();
    while (generated.size < quantity) {
      const code = `VIVIAI-${randomBytes(16).toString('hex').toUpperCase()}`;
      const codeDigest = createHash('sha256').update(code).digest('hex');
      generated.set(codeDigest, {
        code,
        digest: codeDigest,
        displayMask: `VIVIAI-****-${code.slice(-4)}`,
      });
      if (generated.size === quantity) {
        const existing = await tx.redemptionCode.findMany({
          where: { digest: { in: [...generated.keys()] } },
          select: { digest: true },
        });
        for (const row of existing) generated.delete(row.digest);
      }
    }
    return [...generated.values()];
  }

  private campaignDto(row: {
    id: string;
    name: string;
    startsAt: Date;
    endsAt: Date;
    perUserLimit: number;
    credits: number;
    totalLimit: number | null;
    status: string;
    version: number;
    createdAt: Date;
    updatedAt: Date;
  }): MarketingResult {
    return {
      resourceId: row.id,
      id: row.id,
      name: row.name,
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
      perUserLimit: row.perUserLimit,
      credits: row.credits,
      totalLimit: row.totalLimit,
      status: row.status,
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private codeDto(row: {
    id: string;
    campaignId: string;
    displayMask: string;
    status: string;
    maxUses: number;
    usedCount: number;
    version: number;
    createdAt: Date;
    updatedAt: Date;
  }): MarketingResult {
    return {
      resourceId: row.id,
      id: row.id,
      campaignId: row.campaignId,
      displayMask: row.displayMask,
      status: row.status,
      maxUses: row.maxUses,
      usedCount: row.usedCount,
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private version(actual: number, expected: number) {
    if (actual !== expected)
      throw failure(409, 'REDEMPTION_VERSION_CONFLICT', '兑换资源已更新，请重新加载');
    if (actual >= 2_147_483_647)
      throw failure(409, 'REDEMPTION_VERSION_CONFLICT', '兑换资源版本已达上限');
  }
}
