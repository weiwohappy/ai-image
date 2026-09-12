import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { AppConfig } from '../../../config.js';
import { DatabaseService, type DbTransaction } from '../../../shared/database/database.service.js';
import { AppError } from '../../../shared/http/errors.js';
import { APP_CONFIG } from '../../../shared/infrastructure.module.js';
import { Prisma } from '../../../generated/prisma/client.js';
import { AdminAuthService, lockAdmin, type AdminContext } from '../auth.service.js';
import { AdminAuditService, type AuditMetadata } from '../audit.service.js';
import { digest } from '../crypto.js';
import { requirePermission } from '../permissions.js';
import { failure, teamWritesEnabled } from '../team/policy.js';

export interface ContentCommandResult {
  resourceId: string;
  [key: string]: unknown;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, canonical(nested)]),
    );
  return value;
}

@Injectable()
export class AdminContentCommands {
  constructor(
    @Inject(DatabaseService) readonly db: DatabaseService,
    @Inject(APP_CONFIG) readonly config: AppConfig,
    @Inject(AdminAuthService) private readonly auth: AdminAuthService,
    @Inject(AdminAuditService) private readonly audit: AdminAuditService,
  ) {}

  async run<T extends ContentCommandResult>(
    context: AdminContext,
    key: string,
    action: string,
    target: string,
    input: { reason: string; [key: string]: unknown },
    permissions: string[],
    work: (
      tx: DbTransaction,
      current: AdminContext,
    ) => Promise<{ result: T; metadata?: AuditMetadata }>,
  ): Promise<T> {
    if (!z.uuid().safeParse(key).success)
      throw failure(400, 'ADMIN_INVALID_INPUT', '需要有效幂等键');
    if (action.endsWith('.publish')) await this.rateLimitPublish(context, action);
    const requestDigest = digest(JSON.stringify(canonical({ action, target, input })));
    try {
      return await this.db.transaction(async (tx) => {
        await lockAdmin(tx, `content-command:${context.actor.id}:${key}`);
        await lockAdmin(tx, context.actor.id);
        const current = await this.auth.reauthorize(
          tx,
          context.sessionId,
          context.actor.id,
          context.requestIp ?? 'unknown',
        );
        if (!teamWritesEnabled(this.config, current.requestIp))
          throw failure(503, 'ADMIN_TEAM_WRITES_DISABLED', '内容写入仅在本机开发环境开放');
        for (const permission of permissions) requirePermission(current.actor, permission);
        const receipt = await tx.adminCommandReceipt.findUnique({
          where: { accountId_idempotencyKey: { accountId: current.actor.id, idempotencyKey: key } },
        });
        if (receipt) {
          if (receipt.requestDigest !== requestDigest)
            throw failure(409, 'ADMIN_IDEMPOTENCY_CONFLICT', '幂等键已用于其他请求');
          return receipt.result as unknown as T;
        }
        const { result, metadata } = await work(tx, current);
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
            requestDigest,
            result: result as unknown as Prisma.InputJsonObject,
          },
        });
        return result;
      });
    } catch (error) {
      if (error instanceof AppError && [403, 409, 422].includes(error.status)) {
        await this.db.transaction(async (tx) => {
          await lockAdmin(tx, `content-denied:${context.actor.id}:${action}:${target}`);
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

  private async rateLimitPublish(context: AdminContext, action: string): Promise<void> {
    const windowMs = 60_000;
    const ipDigest = digest(context.requestIp ?? 'unknown');
    const buckets = [
      { key: `admin-content-publish:${context.actor.id}:${action}`, limit: 5 },
      { key: `admin-content-publish:ip:${ipDigest}:${action}`, limit: 25 },
    ].sort((left, right) => left.key.localeCompare(right.key));
    const allowed = await this.db.transaction(async (tx) => {
      let permitted = true;
      const now = new Date();
      for (const bucket of buckets) {
        await lockAdmin(tx, `rate:${bucket.key}`);
        const current = await tx.authRateBucket.findUnique({ where: { key: bucket.key } });
        const expired = !current || current.expiresAt <= now;
        const count = expired ? 1 : current.count + 1;
        await tx.authRateBucket.upsert({
          where: { key: bucket.key },
          create: { key: bucket.key, count, expiresAt: new Date(Date.now() + windowMs) },
          update: {
            count,
            ...(expired ? { expiresAt: new Date(Date.now() + windowMs) } : {}),
          },
        });
        if (count > bucket.limit) permitted = false;
      }
      return permitted;
    });
    if (!allowed)
      throw new AppError(429, 'CONTENT_PUBLISH_RATE_LIMITED', '发布操作过于频繁', {
        details: { reason: 'rate_limited', limit: 5, retryAfterSeconds: 60 },
      });
  }
}
