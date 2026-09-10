import { Inject, Injectable } from '@nestjs/common';
import type { AdminRole } from '../../../generated/prisma/client.js';
import type { DbTransaction } from '../../../shared/database/database.service.js';
import type { AdminContext } from '../auth.service.js';
import { lockAdmin } from '../auth.service.js';
import { MANAGEMENT_ROLES, PERMISSION_CATALOG, validPermissionSet } from '../permission-catalog.js';
import { roleOption } from '../permission.service.js';
import { requirePermission } from '../permissions.js';
import { AdminTeamCommands } from './command.service.js';
import {
  actionAvailability,
  enforceAction,
  expectedVersion,
  failure,
  teamWritesEnabled,
} from './policy.js';
import { invalidateAdmin } from './transaction.js';
import { teamQuery, nextCursor } from './pagination.js';
import type { PermissionCatalog, TeamList, TeamRole } from './contracts.js';
const liveInvitation = () => ({ consumedAt: null, revokedAt: null, expiresAt: { gt: new Date() } });
type RoleInput = {
  name: string;
  description: string;
  permissions: string[];
  reason: string;
  expectedVersion?: number;
};
@Injectable()
export class AdminRolesService {
  constructor(@Inject(AdminTeamCommands) readonly commands: AdminTeamCommands) {}
  private async counts(tx: DbTransaction, key: string) {
    return {
      memberCount: await tx.adminAccountRole.count({ where: { roleKey: key } }),
      invitationCount: await tx.adminInvitationRole.count({
        where: { roleKey: key, invitation: liveInvitation() },
      }),
    };
  }
  private async dto(role: AdminRole, context: AdminContext): Promise<TeamRole> {
    const counts = await this.counts(this.commands.db.client, role.key);
    return {
      ...roleOption(role),
      description: role.description,
      version: role.version,
      ...counts,
      allowedActions: (['edit', 'delete'] as const).map((action) => {
        const availability = actionAvailability(
          this.commands.config,
          context,
          action,
          action === 'edit' ? 'roles.update' : 'roles.delete',
          role,
          'role',
        );
        return availability.allowed &&
          action === 'delete' &&
          (counts.memberCount || counts.invitationCount)
          ? { action, allowed: false, reasonCode: 'ADMIN_ROLE_IN_USE' }
          : availability;
      }),
    };
  }
  async list(context: AdminContext, raw: unknown): Promise<TeamList<TeamRole>> {
    requirePermission(context.actor, 'roles.read');
    const q = teamQuery(raw, 'role');
    const rows = await this.commands.db.client.adminRole.findMany({
      ...q.page,
      where: {
        AND: [
          q.where,
          { deletedAt: null },
          ...(q.q
            ? [
                {
                  OR: [
                    { key: { contains: q.q, mode: 'insensitive' as const } },
                    { name: { contains: q.q, mode: 'insensitive' as const } },
                  ],
                },
              ]
            : []),
        ],
      },
    });
    return {
      items: await Promise.all(rows.slice(0, q.limit).map((r) => this.dto(r, context))),
      nextCursor: nextCursor(rows, q.limit),
      asOf: new Date().toISOString(),
      allowedActions: [
        actionAvailability(this.commands.config, context, 'create', 'roles.create', {}, 'role'),
      ],
    };
  }
  async detail(context: AdminContext, key: string) {
    requirePermission(context.actor, 'roles.read');
    const role = await this.commands.db.client.adminRole.findUnique({
      where: { key, deletedAt: null },
    });
    if (!role) throw failure(404, 'ADMIN_NOT_FOUND', '角色不存在');
    return this.dto(role, context);
  }
  async catalog(context: AdminContext): Promise<PermissionCatalog> {
    requirePermission(context.actor, 'roles.read');
    const roles = await this.commands.db.client.adminRole.findMany({
      where: {
        deletedAt: null,
        ...(context.actor.roles.includes('super_admin')
          ? {}
          : { key: { notIn: MANAGEMENT_ROLES } }),
      },
      orderBy: { key: 'asc' },
    });
    return {
      permissions: PERMISSION_CATALOG,
      assignableRoles: roles.map(roleOption),
      writeEnabled: teamWritesEnabled(this.commands.config, context.requestIp),
    };
  }
  create(context: AdminContext, key: string, input: RoleInput & { key: string }) {
    return this.commands.run(
      context,
      key,
      'team.role.create',
      input.key,
      input,
      'roles.create',
      async (tx) => {
        if (!validPermissionSet(input.permissions, true))
          throw failure(400, 'ADMIN_INVALID_INPUT', '权限集合缺少依赖或包含不可选权限');
        if (await tx.adminRole.findUnique({ where: { key: input.key } }))
          throw failure(409, 'ADMIN_ROLE_KEY_EXISTS', '角色标识已被使用');
        const role = await tx.adminRole.create({
          data: {
            key: input.key,
            name: input.name,
            description: input.description,
            permissions: input.permissions,
          },
        });
        return {
          result: { resourceId: role.key, version: role.version },
          metadata: {
            changedFields: ['name', 'description', 'permissions'],
            afterVersion: role.version,
          },
        };
      },
    );
  }
  change(
    context: AdminContext,
    idempotencyKey: string,
    key: string,
    action: 'edit' | 'delete',
    input: RoleInput | { reason: string; expectedVersion: number },
  ) {
    const permission = action === 'edit' ? 'roles.update' : 'roles.delete';
    return this.commands.run(
      context,
      idempotencyKey,
      `team.role.${action}`,
      key,
      input,
      permission,
      async (tx, current) => {
        const role = await tx.adminRole.findUnique({ where: { key, deletedAt: null } });
        if (!role) throw failure(404, 'ADMIN_NOT_FOUND', '角色不存在');
        enforceAction(
          actionAvailability(this.commands.config, current, action, permission, role, 'role'),
        );
        expectedVersion(role, input.expectedVersion);
        const counts = await this.counts(tx, key);
        if (action === 'delete' && (counts.memberCount || counts.invitationCount))
          throw failure(
            409,
            'ADMIN_ROLE_IN_USE',
            `角色仍被引用：成员 ${counts.memberCount}，有效邀请 ${counts.invitationCount}`,
          );
        const edit = 'permissions' in input ? input : null;
        if (edit && !validPermissionSet(edit.permissions, true))
          throw failure(400, 'ADMIN_INVALID_INPUT', '权限集合缺少依赖或包含不可选权限');
        const changed =
          edit && [...role.permissions].sort().join() !== [...edit.permissions].sort().join();
        if (changed) {
          const bindings = await tx.adminAccountRole.findMany({
            where: { roleKey: key },
            orderBy: { accountId: 'asc' },
          });
          for (const binding of bindings) {
            await lockAdmin(tx, binding.accountId);
            await tx.adminAccount.update({
              where: { id: binding.accountId },
              data: { authVersion: { increment: 1 }, version: { increment: 1 } },
            });
            await invalidateAdmin(tx, binding.accountId);
          }
          await tx.adminInvitation.updateMany({
            where: { consumedAt: null, roleBindings: { some: { roleKey: key } } },
            data: { version: { increment: 1 } },
          });
        }
        const updated = await tx.adminRole.update({
          where: { key },
          data: {
            version: { increment: 1 },
            ...(edit
              ? { name: edit.name, description: edit.description, permissions: edit.permissions }
              : { deletedAt: new Date() }),
          },
        });
        return {
          result: { resourceId: key, version: updated.version },
          metadata: {
            beforeVersion: role.version,
            afterVersion: updated.version,
            changedFields: edit
              ? ['name', 'description', ...(changed ? ['permissions'] : [])]
              : ['deletedAt'],
            ...counts,
          },
        };
      },
    );
  }
}
