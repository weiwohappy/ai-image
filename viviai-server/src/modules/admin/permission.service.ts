import { Injectable } from '@nestjs/common';
import type { DbTransaction } from '../../shared/database/database.service.js';
import { MANAGEMENT_ROLES, ROLE_PERMISSIONS, validPermissionSet } from './permission-catalog.js';
import { AppError } from '../../shared/http/errors.js';
import type { RoleOption } from './team/contracts.js';
export const roleInclude = { roleBindings: { include: { role: true } } } as const;
type RoleRecord = {
  key: string;
  name: string;
  builtIn: boolean;
  permissions: string[];
  deletedAt: Date | null;
};
export function roleOption(role: RoleRecord): RoleOption {
  return {
    key: role.key,
    name: role.name,
    builtIn: role.builtIn,
    permissions: [...role.permissions].sort(),
  };
}
@Injectable()
export class AdminPermissionService {
  resolve(bindings: { role: RoleRecord }[], extras: string[]) {
    if (
      !bindings.length ||
      extras.some((p) => p !== 'sensitive.read') ||
      bindings.some(
        (b) =>
          b.role.deletedAt ||
          (b.role.builtIn && !Object.hasOwn(ROLE_PERMISSIONS, b.role.key)) ||
          !validPermissionSet(b.role.permissions, !b.role.builtIn),
      )
    )
      return { roles: [], permissions: [] };
    return {
      roles: bindings.map((b) => b.role.key).sort(),
      permissions: [...new Set([...bindings.flatMap((b) => b.role.permissions), ...extras])].sort(),
    };
  }
  async account(tx: DbTransaction, id: string) {
    const account = await tx.adminAccount.findUnique({ where: { id }, include: roleInclude });
    return account
      ? this.resolve(account.roleBindings, account.extraPermissions)
      : { roles: [], permissions: [] };
  }
  protected(roles: string[], extras: string[]) {
    return extras.length > 0 || roles.some((key) => MANAGEMENT_ROLES.includes(key));
  }
  async assignable(tx: DbTransaction, keys: string[], superAdmin: boolean, invitation = false) {
    if (!keys.length || keys.length > 10 || new Set(keys).size !== keys.length)
      throw new AppError(400, 'ADMIN_INVALID_INPUT', '角色集合无效');
    const roles = await tx.adminRole.findMany({
      where: { key: { in: keys }, deletedAt: null },
      orderBy: { key: 'asc' },
    });
    if (
      roles.length !== keys.length ||
      roles.some((r) => !validPermissionSet(r.permissions, !r.builtIn))
    )
      throw new AppError(400, 'ADMIN_INVALID_INPUT', '角色不可用');
    if (
      (!superAdmin && keys.some((k) => MANAGEMENT_ROLES.includes(k))) ||
      (invitation && keys.includes('super_admin'))
    )
      throw new AppError(403, 'ADMIN_TARGET_PROTECTED', '不能分配此管理角色');
    return roles;
  }
}
