import { z } from 'zod';
import type { AppConfig } from '../../../config.js';
import type { AdminAccount } from '../../../generated/prisma/client.js';
import type { AdminContext } from '../auth.service.js';
import { allowsLocalPasswordLogin } from '../config.js';
import { MANAGEMENT_ROLES } from '../permission-catalog.js';
import { AppError } from '../../../shared/http/errors.js';
import type { AllowedAction, TeamAction } from './contracts.js';
export function teamWritesEnabled(config: AppConfig, ip = '127.0.0.1') {
  return !!(
    config.admin?.enabled &&
    config.nodeEnv === 'development' &&
    ['localhost', '127.0.0.1', '::1'].includes(config.host) &&
    ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip) &&
    config.admin.origins.length &&
    config.admin.origins.every((origin) => {
      try {
        const u = new URL(origin);
        return (
          u.origin === origin &&
          ['http:', 'https:'].includes(u.protocol) &&
          ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
        );
      } catch {
        return false;
      }
    })
  );
}
export const failure = (status: number, code: string, message: string) =>
  new AppError(status, code, message);
export function usable(
  account: Pick<AdminAccount, 'status' | 'disabledAt' | 'email'>,
  config: AppConfig,
) {
  return (
    !account.disabledAt &&
    (account.status === 'active' ||
      (account.status === 'pending' &&
        allowsLocalPasswordLogin(config, account.email, '127.0.0.1')))
  );
}
export const commandSchema = {
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(5).max(500),
};
export const nameSchema = z.string().trim().min(1).max(80);
export const emailSchema = z
  .string()
  .trim()
  .email()
  .max(254)
  .transform((s) => s.toLowerCase());
export const rolesSchema = z
  .array(z.string().min(1).max(64))
  .min(1)
  .max(10)
  .refine((a) => new Set(a).size === a.length)
  .transform((a) => [...a].sort());
export type ActionTarget = {
  id?: string;
  roleKeys?: string[];
  extraPermissions?: string[];
  disabledAt?: Date | null;
  consumedAt?: Date | null;
  builtIn?: boolean;
};
export function actionAvailability(
  config: AppConfig,
  context: AdminContext,
  action: TeamAction,
  permission: string,
  target: ActionTarget = {},
  kind: 'member' | 'invitation' | 'role' = 'member',
): AllowedAction {
  let reasonCode: string | null = null;
  if (!teamWritesEnabled(config, context.requestIp)) reasonCode = 'ADMIN_TEAM_WRITES_DISABLED';
  else if (
    !context.actor.permissions.includes(permission) ||
    !context.actor.permissions.includes('admins.read')
  )
    reasonCode = 'ADMIN_FORBIDDEN';
  else if (kind === 'role' && target.builtIn) reasonCode = 'ADMIN_BUILTIN_ROLE';
  else if (kind === 'invitation' && target.consumedAt) reasonCode = 'ADMIN_INVITATION_CONSUMED';
  else if (
    kind === 'member' &&
    target.id === context.actor.id &&
    ['assignRoles', 'enable', 'disable', 'resetPassword'].includes(action)
  )
    reasonCode = 'ADMIN_SELF_PROTECTED';
  else if (
    kind !== 'role' &&
    !(kind === 'member' && target.id === context.actor.id && action === 'edit') &&
    !context.actor.roles.includes('super_admin') &&
    ((target.extraPermissions?.length ?? 0) > 0 ||
      target.roleKeys?.some((k) => MANAGEMENT_ROLES.includes(k)))
  )
    reasonCode = 'ADMIN_TARGET_PROTECTED';
  else if (action === 'resetPassword' && target.disabledAt) reasonCode = 'ADMIN_ACCOUNT_DISABLED';
  return { action, allowed: !reasonCode, reasonCode };
}
export function enforceAction(result: AllowedAction) {
  if (!result.allowed)
    throw failure(
      result.reasonCode === 'ADMIN_TEAM_WRITES_DISABLED'
        ? 503
        : ['ADMIN_FORBIDDEN', 'ADMIN_TARGET_PROTECTED'].includes(result.reasonCode!)
          ? 403
          : 409,
      result.reasonCode!,
      '当前对象不允许此操作',
    );
}
export function expectedVersion(value: { version: number }, version: number | undefined) {
  if (value.version !== version)
    throw failure(409, 'ADMIN_VERSION_CONFLICT', '记录已更新，请重新加载后比较');
}
