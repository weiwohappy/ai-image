import { Inject, Injectable } from '@nestjs/common';
import { AdminTeamCommands } from './command.service.js';
import { AdminMembersService } from './members.service.js';
import { AdminPermissionService, roleInclude } from '../permission.service.js';
import { lockAdmin, type AdminContext } from '../auth.service.js';
import {
  actionAvailability,
  enforceAction,
  expectedVersion,
  failure,
  teamWritesEnabled,
} from './policy.js';
import { digest, hashPassword, token } from '../crypto.js';
import { adminPasswordMinimum } from '../config.js';
import { invalidateAdmin, lockTeam } from './transaction.js';
@Injectable()
export class AdminPasswordResetService {
  constructor(
    @Inject(AdminTeamCommands) readonly commands: AdminTeamCommands,
    @Inject(AdminMembersService) readonly members: AdminMembersService,
    @Inject(AdminPermissionService) readonly permissions: AdminPermissionService,
  ) {}
  issue(
    context: AdminContext,
    key: string,
    id: string,
    input: { expectedVersion: number; reason: string },
  ) {
    return this.commands.run(
      context,
      key,
      'team.member.resetPassword',
      id,
      input,
      'admins.password.reset',
      async (tx, current) => {
        const member = await tx.adminAccount.findUnique({ where: { id }, include: roleInclude });
        if (!member) throw failure(404, 'ADMIN_NOT_FOUND', '成员不存在');
        enforceAction(
          actionAvailability(
            this.commands.config,
            current,
            'resetPassword',
            'admins.password.reset',
            this.members.target(member),
          ),
        );
        expectedVersion(member, input.expectedVersion);
        await invalidateAdmin(tx, id);
        const updated = await tx.adminAccount.update({
          where: { id },
          data: { version: { increment: 1 }, authVersion: { increment: 1 } },
        });
        const raw = token(),
          expiresAt = new Date(Date.now() + 1800000);
        const reset = await tx.adminPasswordReset.create({
          data: { accountId: id, tokenHash: digest(raw), expiresAt, createdBy: current.actor.id },
        });
        return {
          result: {
            resourceId: id,
            version: updated.version,
            expiresAt: expiresAt.toISOString(),
            link: `${this.commands.config.admin!.origins[0]}/#/reset-password?${new URLSearchParams({ token: raw, email: member.email })}`,
          },
          metadata: {
            credentialId: reset.id,
            beforeVersion: member.version,
            afterVersion: updated.version,
            changedFields: ['passwordReset'],
          },
        };
      },
      { accounts: [id] },
    );
  }
  async accept(input: { token: string; email: string; password: string }, ip: string) {
    this.commands.auth.enabled();
    if (!teamWritesEnabled(this.commands.config, ip))
      throw failure(503, 'ADMIN_TEAM_WRITES_DISABLED', '团队写入仅在本机开发环境开放');
    await this.commands.auth.rate(ip, `password-reset:${input.email}`, 10);
    const invalid = () => failure(400, 'ADMIN_INVALID_RESET', '重置链接无效、失效或已使用');
    const minimum = adminPasswordMinimum(this.commands.config, input.email, ip);
    if (input.password.length < minimum || input.password.length > 128) throw invalid();
    const passwordHash = await hashPassword(input.password, minimum);
    await this.commands.db.transaction(async (tx) => {
      await lockTeam(tx);
      await lockAdmin(tx, `email:${input.email}`);
      const reset = await tx.adminPasswordReset.findUnique({
        where: { tokenHash: digest(input.token) },
      });
      if (!reset) throw invalid();
      await lockAdmin(tx, reset.accountId);
      const account = await tx.adminAccount.findUnique({ where: { id: reset.accountId } });
      if (
        !account ||
        account.email !== input.email ||
        account.disabledAt ||
        reset.consumedAt ||
        reset.revokedAt ||
        reset.expiresAt <= new Date() ||
        !(await this.permissions.account(tx, account.id)).permissions.length
      )
        throw invalid();
      await tx.adminPasswordReset.update({
        where: { id: reset.id },
        data: { consumedAt: new Date() },
      });
      await tx.adminAccount.update({
        where: { id: account.id },
        data: { passwordHash, authVersion: { increment: 1 }, version: { increment: 1 } },
      });
      await invalidateAdmin(tx, account.id);
      await this.commands.audit.write(
        tx,
        'password-reset.accept',
        'allowed',
        account.id,
        undefined,
        account.id,
        undefined,
        {
          credentialId: reset.id,
          changedFields: ['password'],
          beforeVersion: account.version,
          afterVersion: account.version + 1,
        },
      );
    });
    return { success: true };
  }
}
