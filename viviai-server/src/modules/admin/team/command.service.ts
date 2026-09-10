import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService, type DbTransaction } from '../../../shared/database/database.service.js';
import { APP_CONFIG } from '../../../shared/infrastructure.module.js';
import type { AppConfig } from '../../../config.js';
import { AppError } from '../../../shared/http/errors.js';
import { AdminAuthService, lockAdmin, type AdminContext } from '../auth.service.js';
import { AdminAuditService, type AuditMetadata } from '../audit.service.js';
import { digest } from '../crypto.js';
import { requirePermission } from '../permissions.js';
import { failure, teamWritesEnabled } from './policy.js';
import { lockTeam } from './transaction.js';
import type { TeamMutationResult } from './contracts.js';
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
@Injectable()
export class AdminTeamCommands {
  constructor(
    @Inject(DatabaseService) readonly db: DatabaseService,
    @Inject(APP_CONFIG) readonly config: AppConfig,
    @Inject(AdminAuthService) readonly auth: AdminAuthService,
    @Inject(AdminAuditService) readonly audit: AdminAuditService,
  ) {}
  async run(
    context: AdminContext,
    key: string,
    action: string,
    target: string,
    input: { reason: string },
    permission: string,
    work: (
      tx: DbTransaction,
      current: AdminContext,
    ) => Promise<{ result: TeamMutationResult; metadata?: AuditMetadata }>,
    locks: { email?: string; invitation?: string; accounts?: string[] } = {},
  ) {
    if (!z.uuid().safeParse(key).success)
      throw failure(400, 'ADMIN_INVALID_INPUT', '需要有效幂等键');
    const requestDigest = digest(JSON.stringify(canonical({ action, target, input })));
    try {
      return await this.db.transaction(async (tx) => {
        await lockTeam(tx);
        const invitation = locks.invitation
          ? await tx.adminInvitation.findUnique({
              where: { id: locks.invitation },
              select: { email: true, tokenHash: true },
            })
          : null;
        const email = locks.email ?? invitation?.email;
        if (email) await lockAdmin(tx, `email:${email}`);
        if (invitation) await lockAdmin(tx, `invitation:${invitation.tokenHash}`);
        const affected =
          action === 'team.role.edit'
            ? (
                await tx.adminAccountRole.findMany({
                  where: { roleKey: target },
                  select: { accountId: true },
                })
              ).map((b) => b.accountId)
            : [];
        for (const id of [
          ...new Set([context.actor.id, ...(locks.accounts ?? []), ...affected]),
        ].sort())
          await lockAdmin(tx, id);
        const current = await this.auth.reauthorize(
          tx,
          context.sessionId,
          context.actor.id,
          context.requestIp ?? 'unknown',
        );
        if (!teamWritesEnabled(this.config, current.requestIp))
          throw failure(503, 'ADMIN_TEAM_WRITES_DISABLED', '团队写入仅在本机开发环境开放');
        requirePermission(
          current.actor,
          permission === 'model-pricing.write' ? 'models.read' : 'admins.read',
        );
        requirePermission(current.actor, permission);
        const receipt = await tx.adminCommandReceipt.findUnique({
          where: { accountId_idempotencyKey: { accountId: current.actor.id, idempotencyKey: key } },
        });
        if (receipt) {
          if (receipt.requestDigest !== requestDigest)
            throw failure(409, 'ADMIN_IDEMPOTENCY_CONFLICT', '幂等键已用于其他请求');
          return receipt.result as unknown as TeamMutationResult;
        }
        const { result, metadata } = await work(tx, current);
        const { link, ...safe } = result;
        const stored = { ...safe, ...(link ? { linkUnavailable: true } : {}) };
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
            result: stored,
          },
        });
        return result;
      });
    } catch (error) {
      if (error instanceof AppError && [403, 409].includes(error.status)) {
        // One rejection event per actor/action per ten minutes limits repeated denied requests.
        await this.db.transaction(async (tx) => {
          await lockTeam(tx);
          const recent = await tx.adminAuditEvent.findFirst({
            where: {
              accountId: context.actor.id,
              action,
              outcome: 'denied',
              createdAt: { gt: new Date(Date.now() - 600000) },
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
              undefined,
              { code: error.code },
            );
        });
      }
      throw error;
    }
  }
}
