import type { AppConfig } from '../../../config.js';
import type { DatabaseService } from '../../../shared/database/database.service.js';
import { z } from 'zod';
import { validateAdminConfig } from '../config.js';
import { AdminPermissionService, roleInclude } from '../permission.service.js';
import { AdminAuditService } from '../audit.service.js';
import { lockAdmin } from '../auth.service.js';
import { digest } from '../crypto.js';
import { commandSchema, expectedVersion, failure, teamWritesEnabled, usable } from './policy.js';
import { lockTeam, invalidateAdmin } from './transaction.js';
export async function bootstrapSuperAdministrator(
  db: DatabaseService,
  config: AppConfig,
  input: { email: string; expectedVersion: number; reason: string; apply: boolean },
): Promise<{ accountId: string; roles: string[]; version: number; applied: boolean }> {
  const data = z
    .object({
      email: z
        .string()
        .email()
        .max(254)
        .refine((s) => s === s.trim().toLowerCase()),
      ...commandSchema,
      apply: z.boolean(),
    })
    .strict()
    .parse(input);
  validateAdminConfig(config.admin, config.nodeEnv, config.host);
  if (!teamWritesEnabled(config))
    throw failure(503, 'ADMIN_TEAM_WRITES_DISABLED', '首次超级管理员命令仅限本机开发环境');
  return db.transaction(async (tx) => {
    await lockTeam(tx);
    await lockAdmin(tx, `email:${data.email}`);
    if (await tx.adminAccountRole.count({ where: { roleKey: 'super_admin' } }))
      throw failure(409, 'ADMIN_SUPER_ADMIN_EXISTS', '已有超级管理员，请使用团队界面');
    const account = await tx.adminAccount.findUnique({
      where: { email: data.email },
      include: roleInclude,
    });
    if (!account) throw failure(404, 'ADMIN_NOT_FOUND', '成员不存在');
    await lockAdmin(tx, account.id);
    expectedVersion(account, data.expectedVersion);
    if (
      !usable(account, config) ||
      !new AdminPermissionService().resolve(account.roleBindings, account.extraPermissions)
        .permissions.length
    )
      throw failure(409, 'ADMIN_SUPER_ADMIN_NOT_USABLE', '目标必须是可登录成员');
    const roles = [...account.roleBindings.map((b) => b.roleKey), 'super_admin'].sort();
    if (!data.apply)
      return { accountId: account.id, roles, version: account.version, applied: false };
    await tx.adminAccountRole.create({ data: { accountId: account.id, roleKey: 'super_admin' } });
    const updated = await tx.adminAccount.update({
      where: { id: account.id },
      data: { version: { increment: 1 }, authVersion: { increment: 1 } },
    });
    await invalidateAdmin(tx, account.id);
    await new AdminAuditService().write(
      tx,
      'team.super.bootstrap',
      'allowed',
      undefined,
      undefined,
      account.id,
      digest(data.reason),
      {
        beforeRoles: account.roleBindings.map((b) => b.roleKey),
        afterRoles: roles,
        beforeVersion: account.version,
        afterVersion: updated.version,
        changedFields: ['roles'],
      },
    );
    return { accountId: account.id, roles, version: updated.version, applied: true };
  });
}
