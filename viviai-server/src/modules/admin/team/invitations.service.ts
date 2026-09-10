import { Inject, Injectable } from '@nestjs/common';
import type { AdminContext } from '../auth.service.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { AdminPermissionService, roleInclude, roleOption } from '../permission.service.js';
import { requirePermission } from '../permissions.js';
import { digest, token } from '../crypto.js';
import { actionAvailability, enforceAction, expectedVersion, failure } from './policy.js';
import { AdminTeamCommands } from './command.service.js';
import { teamQuery, nextCursor } from './pagination.js';
import type { TeamInvitation, TeamList } from './contracts.js';
type Invitation = Prisma.AdminInvitationGetPayload<{ include: typeof roleInclude }>;
export function invitationStatus(i: {
  consumedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
}): TeamInvitation['status'] {
  return i.consumedAt
    ? 'consumed'
    : i.revokedAt
      ? 'revoked'
      : i.expiresAt <= new Date()
        ? 'expired'
        : 'pending';
}
@Injectable()
export class AdminInvitationsService {
  constructor(
    @Inject(AdminTeamCommands) readonly commands: AdminTeamCommands,
    @Inject(AdminPermissionService) readonly permissions: AdminPermissionService,
  ) {}
  private target(i: Invitation) {
    return { ...i, roleKeys: i.roleBindings.map((b) => b.roleKey) };
  }
  private dto(i: Invitation, context: AdminContext): TeamInvitation {
    return {
      id: i.id,
      email: i.email,
      displayName: i.displayName,
      roles: i.roleBindings.map((b) => roleOption(b.role)),
      status: invitationStatus(i),
      version: i.version,
      createdAt: i.createdAt.toISOString(),
      expiresAt: i.expiresAt.toISOString(),
      allowedActions: ['edit', 'rotate', 'revoke'].map((action) =>
        actionAvailability(
          this.commands.config,
          context,
          action as 'edit' | 'rotate' | 'revoke',
          'admins.create',
          this.target(i),
          'invitation',
        ),
      ),
    };
  }
  async list(context: AdminContext, raw: unknown): Promise<TeamList<TeamInvitation>> {
    requirePermission(context.actor, 'admins.read');
    const q = teamQuery(raw, 'invitation');
    const now = new Date();
    const where: Prisma.AdminInvitationWhereInput = {
      ...q.where,
      ...(q.email ? { email: q.email } : {}),
      ...(q.status === 'consumed'
        ? { consumedAt: { not: null } }
        : q.status === 'revoked'
          ? { consumedAt: null, revokedAt: { not: null } }
          : q.status === 'expired'
            ? { consumedAt: null, revokedAt: null, expiresAt: { lte: now } }
            : q.status === 'pending'
              ? { consumedAt: null, revokedAt: null, expiresAt: { gt: now } }
              : {}),
    };
    const rows = await this.commands.db.client.adminInvitation.findMany({
      ...q.page,
      where,
      include: roleInclude,
    });
    const create = actionAvailability(this.commands.config, context, 'create', 'admins.create');
    if (create.allowed && !context.actor.permissions.includes('admins.roles.assign')) {
      create.allowed = false;
      create.reasonCode = 'ADMIN_FORBIDDEN';
    }
    return {
      items: rows.slice(0, q.limit).map((i) => this.dto(i, context)),
      nextCursor: nextCursor(rows, q.limit),
      asOf: now.toISOString(),
      allowedActions: [create],
    };
  }
  create(
    context: AdminContext,
    key: string,
    input: { email: string; displayName: string; roles: string[]; reason: string },
  ) {
    return this.commands.run(
      context,
      key,
      'team.invitation.create',
      input.email,
      input,
      'admins.create',
      async (tx, current) => {
        requirePermission(current.actor, 'admins.roles.assign');
        await this.permissions.assignable(
          tx,
          input.roles,
          current.actor.roles.includes('super_admin'),
          true,
        );
        if (await tx.adminAccount.findUnique({ where: { email: input.email } }))
          throw failure(409, 'ADMIN_ACCOUNT_EXISTS', '此邮箱已有成员');
        if (await tx.adminInvitation.findUnique({ where: { email: input.email } }))
          throw failure(409, 'ADMIN_INVITATION_EXISTS', '此邮箱已有邀请，请在原邀请上重新生成');
        const raw = token(),
          expiresAt = new Date(Date.now() + 86400000);
        const i = await tx.adminInvitation.create({
          data: {
            email: input.email,
            displayName: input.displayName,
            roleBindings: { create: input.roles.map((roleKey) => ({ roleKey })) },
            tokenHash: digest(raw),
            expiresAt,
            createdBy: current.actor.id,
          },
        });
        return {
          result: {
            resourceId: i.id,
            version: i.version,
            link: this.link(raw, i),
            expiresAt: expiresAt.toISOString(),
          },
          metadata: { afterRoles: input.roles, afterVersion: i.version, credentialId: i.id },
        };
      },
      { email: input.email },
    );
  }
  private link(raw: string, i: { email: string; displayName: string }) {
    return `${this.commands.config.admin!.origins[0]}/#/accept?${new URLSearchParams({ token: raw, email: i.email, displayName: i.displayName })}`;
  }
  change(
    context: AdminContext,
    key: string,
    id: string,
    action: 'edit' | 'rotate' | 'revoke',
    input: {
      expectedVersion: number;
      reason: string;
      displayName?: string | undefined;
      roles?: string[] | undefined;
    },
  ) {
    return this.commands.run(
      context,
      key,
      `team.invitation.${action}`,
      id,
      input,
      'admins.create',
      async (tx, current) => {
        const i = await tx.adminInvitation.findUnique({ where: { id }, include: roleInclude });
        if (!i) throw failure(404, 'ADMIN_NOT_FOUND', '邀请不存在');
        enforceAction(
          actionAvailability(
            this.commands.config,
            current,
            action,
            'admins.create',
            this.target(i),
            'invitation',
          ),
        );
        expectedVersion(i, input.expectedVersion);
        if (input.roles) {
          requirePermission(current.actor, 'admins.roles.assign');
          await this.permissions.assignable(
            tx,
            input.roles,
            current.actor.roles.includes('super_admin'),
            true,
          );
        }
        if (action === 'rotate') {
          await this.permissions.assignable(
            tx,
            i.roleBindings.map((b) => b.roleKey),
            current.actor.roles.includes('super_admin'),
            true,
          );
          if (await tx.adminAccount.findUnique({ where: { email: i.email } }))
            throw failure(409, 'ADMIN_ACCOUNT_EXISTS', '此邮箱已有成员');
        }
        const raw = action === 'rotate' ? token() : undefined;
        const changedRoles =
          input.roles &&
          [...i.roleBindings.map((b) => b.roleKey)].sort().join() !== input.roles.join();
        const updated = await tx.adminInvitation.update({
          where: { id },
          data: {
            version: { increment: 1 },
            ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
            ...(input.roles
              ? {
                  roleBindings: {
                    deleteMany: {},
                    create: input.roles.map((roleKey) => ({ roleKey })),
                  },
                }
              : {}),
            ...(changedRoles || action === 'revoke' ? { revokedAt: new Date() } : {}),
            ...(raw
              ? {
                  tokenHash: digest(raw),
                  revokedAt: null,
                  expiresAt: new Date(Date.now() + 86400000),
                }
              : {}),
          },
        });
        return {
          result: {
            resourceId: id,
            version: updated.version,
            ...(raw
              ? { link: this.link(raw, updated), expiresAt: updated.expiresAt.toISOString() }
              : {}),
          },
          metadata: {
            beforeVersion: i.version,
            afterVersion: updated.version,
            beforeRoles: i.roleBindings.map((b) => b.roleKey),
            afterRoles: input.roles ?? i.roleBindings.map((b) => b.roleKey),
            changedFields:
              action === 'edit'
                ? [
                    ...(input.displayName !== undefined ? ['displayName'] : []),
                    ...(input.roles ? ['roles'] : []),
                  ]
                : action === 'rotate'
                  ? ['expiresAt', 'revokedAt']
                  : ['revokedAt'],
          },
        };
      },
      { invitation: id },
    );
  }
}
