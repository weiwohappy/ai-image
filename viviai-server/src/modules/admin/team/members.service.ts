import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client.js';
import type { DbTransaction } from '../../../shared/database/database.service.js';
import type { AdminContext } from '../auth.service.js';
import { AdminPermissionService, roleInclude, roleOption } from '../permission.service.js';
import { requirePermission } from '../permissions.js';
import { AdminTeamCommands } from './command.service.js';
import { actionAvailability, enforceAction, expectedVersion, failure, usable } from './policy.js';
import { invalidateAdmin } from './transaction.js';
import { teamQuery, nextCursor } from './pagination.js';
import type { TeamAction, TeamList, TeamMember } from './contracts.js';
type Member = Prisma.AdminAccountGetPayload<{ include: typeof roleInclude }>;
const actions: [TeamAction, string][] = [
  ['edit', 'admins.update'],
  ['assignRoles', 'admins.roles.assign'],
  ['enable', 'admins.status.update'],
  ['disable', 'admins.status.update'],
  ['resetPassword', 'admins.password.reset'],
];
@Injectable()
export class AdminMembersService {
  constructor(
    @Inject(AdminTeamCommands) readonly commands: AdminTeamCommands,
    @Inject(AdminPermissionService) readonly permissions: AdminPermissionService,
  ) {}
  target(m: Member) {
    return { ...m, roleKeys: m.roleBindings.map((b) => b.roleKey) };
  }
  private dto(m: Member, context: AdminContext): TeamMember {
    return {
      id: m.id,
      email: m.email,
      displayName: m.displayName,
      status: m.disabledAt ? 'disabled' : m.status === 'active' ? 'active' : 'pending',
      activated: m.status === 'active',
      roles: m.roleBindings.map((b) => roleOption(b.role)),
      version: m.version,
      createdAt: m.createdAt.toISOString(),
      allowedActions: actions.map(([action, permission]) =>
        actionAvailability(this.commands.config, context, action, permission, this.target(m)),
      ),
    };
  }
  async list(context: AdminContext, raw: unknown): Promise<TeamList<TeamMember>> {
    requirePermission(context.actor, 'admins.read');
    const q = teamQuery(raw, 'member');
    const rows = await this.commands.db.client.adminAccount.findMany({
      ...q.page,
      include: roleInclude,
      where: {
        ...q.where,
        ...(q.email ? { email: q.email } : {}),
        ...(q.role ? { roleBindings: { some: { roleKey: q.role } } } : {}),
        ...(q.status === 'disabled'
          ? { disabledAt: { not: null } }
          : q.status
            ? { disabledAt: null, status: q.status }
            : {}),
      },
    });
    const create = actionAvailability(this.commands.config, context, 'create', 'admins.create');
    if (create.allowed && !context.actor.permissions.includes('admins.roles.assign')) {
      create.allowed = false;
      create.reasonCode = 'ADMIN_FORBIDDEN';
    }
    return {
      items: rows.slice(0, q.limit).map((m) => this.dto(m, context)),
      nextCursor: nextCursor(rows, q.limit),
      asOf: new Date().toISOString(),
      allowedActions: [create],
    };
  }
  async detail(context: AdminContext, id: string) {
    requirePermission(context.actor, 'admins.read');
    const member = await this.commands.db.client.adminAccount.findUnique({
      where: { id },
      include: roleInclude,
    });
    if (!member) throw failure(404, 'ADMIN_NOT_FOUND', '成员不存在');
    return this.dto(member, context);
  }
  async protectLastSuper(tx: DbTransaction, member: Member) {
    if (
      !member.roleBindings.some((b) => b.roleKey === 'super_admin') ||
      !usable(member, this.commands.config)
    )
      return;
    const supers = await tx.adminAccount.findMany({
      where: { roleBindings: { some: { roleKey: 'super_admin' } } },
    });
    if (!supers.some((m) => m.id !== member.id && usable(m, this.commands.config)))
      throw failure(409, 'ADMIN_LAST_SUPER_ADMIN', '必须保留至少一位可登录超级管理员');
  }
  change(
    context: AdminContext,
    key: string,
    id: string,
    action: 'edit' | 'assignRoles' | 'enable' | 'disable',
    input: { expectedVersion: number; reason: string; displayName?: string; roles?: string[] },
  ) {
    const permission = actions.find(([a]) => a === action)![1];
    return this.commands.run(
      context,
      key,
      `team.member.${action}`,
      id,
      input,
      permission,
      async (tx, current) => {
        const member = await tx.adminAccount.findUnique({ where: { id }, include: roleInclude });
        if (!member) throw failure(404, 'ADMIN_NOT_FOUND', '成员不存在');
        enforceAction(
          actionAvailability(
            this.commands.config,
            current,
            action,
            permission,
            this.target(member),
          ),
        );
        expectedVersion(member, input.expectedVersion);
        if (action === 'assignRoles') {
          await this.permissions.assignable(
            tx,
            input.roles!,
            current.actor.roles.includes('super_admin'),
          );
          if (input.roles!.includes('super_admin') && !usable(member, this.commands.config))
            throw failure(
              409,
              'ADMIN_SUPER_ADMIN_NOT_USABLE',
              '需先完成登录激活才能提升超级管理员',
            );
          if (!input.roles!.includes('super_admin')) await this.protectLastSuper(tx, member);
        }
        if (action === 'disable') await this.protectLastSuper(tx, member);
        const updated = await tx.adminAccount.update({
          where: { id },
          data: {
            version: { increment: 1 },
            ...(action === 'edit'
              ? { displayName: input.displayName! }
              : { authVersion: { increment: 1 } }),
            ...(action === 'assignRoles'
              ? {
                  roleBindings: {
                    deleteMany: {},
                    create: input.roles!.map((roleKey) => ({ roleKey })),
                  },
                }
              : {}),
            ...(action === 'disable'
              ? { disabledAt: new Date() }
              : action === 'enable'
                ? { disabledAt: null }
                : {}),
          },
        });
        if (action !== 'edit') await invalidateAdmin(tx, id);
        return {
          result: { resourceId: id, version: updated.version },
          metadata: {
            beforeVersion: member.version,
            afterVersion: updated.version,
            beforeRoles: member.roleBindings.map((b) => b.roleKey),
            afterRoles: input.roles ?? member.roleBindings.map((b) => b.roleKey),
            beforeStatus: member.disabledAt ? 'disabled' : member.status,
            afterStatus: updated.disabledAt ? 'disabled' : updated.status,
            changedFields: [
              action === 'edit' ? 'displayName' : action === 'assignRoles' ? 'roles' : 'disabledAt',
            ],
          },
        };
      },
      { accounts: [id] },
    );
  }
}
