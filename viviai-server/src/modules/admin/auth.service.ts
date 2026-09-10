import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../config.js';
import type { AdminAccount, AdminSession } from '../../generated/prisma/client.js';
import { DatabaseService, type DbTransaction } from '../../shared/database/database.service.js';
import { APP_CONFIG } from '../../shared/infrastructure.module.js';
import { AppError } from '../../shared/http/errors.js';
import { AdminAuditService } from './audit.service.js';
import {
  decryptSecret,
  digest,
  encryptSecret,
  hashPassword,
  newSecret,
  recoveryCodes,
  token,
  verifyPassword,
  verifyTotp,
} from './crypto.js';
import { AdminPermissionService, roleInclude } from './permission.service.js';
import { lockTeam } from './team/transaction.js';
import type { AdminActor } from './contracts.js';
import { adminPasswordMinimum, allowsLocalPasswordLogin } from './config.js';
export const ADMIN_COOKIE = 'viviai_admin_session';
export const CHALLENGE_COOKIE = 'viviai_admin_challenge';
export const denied = () =>
  new AppError(401, 'ADMIN_AUTH_REQUIRED', 'Administrator authentication required');
export async function lockAdmin(tx: DbTransaction, id: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`admin:${id}`}, 0))`;
}
export function actor(
  account: AdminAccount,
  session: AdminSession,
  resolved: { roles: string[]; permissions: string[] },
): AdminActor {
  return {
    id: account.id,
    email: account.email,
    displayName: account.displayName,
    ...resolved,
    sessionExpiresAt: session.expiresAt.toISOString(),
  };
}
export interface AdminContext {
  actor: AdminActor;
  sessionId: string;
  requestIp?: string;
}
@Injectable()
export class AdminAuthService {
  constructor(
    @Inject(DatabaseService) readonly db: DatabaseService,
    @Inject(APP_CONFIG) readonly config: AppConfig,
    @Inject(AdminAuditService) private readonly audit: AdminAuditService,
    @Inject(AdminPermissionService) private readonly permissionService: AdminPermissionService,
  ) {}
  enabled() {
    if (!this.config.admin?.enabled) throw denied();
  }
  private passwordMinimum(password: string, email: string, ip: string) {
    const minimum = adminPasswordMinimum(this.config, email, ip);
    if (password.length < minimum || password.length > 128)
      throw new AppError(400, 'ADMIN_INVALID_INPUT', 'Invalid administrator request');
    return minimum;
  }
  async rate(ip: string, credential: string, limit = 10) {
    const ok = await this.db.transaction(async (tx) => {
      let allowed = true;
      for (const [name, max] of [
        [`ip:${digest(ip)}`, 100],
        [`credential:${digest(credential)}`, limit],
      ] as const) {
        const key = `admin:${name}`;
        await lockAdmin(tx, key);
        const old = await tx.authRateBucket.findUnique({ where: { key } });
        const now = new Date();
        const count = old && old.expiresAt > now ? old.count + 1 : 1;
        await tx.authRateBucket.upsert({
          where: { key },
          create: { key, count, expiresAt: new Date(Date.now() + 600000) },
          update: {
            count,
            ...(!old || old.expiresAt <= now ? { expiresAt: new Date(Date.now() + 600000) } : {}),
          },
        });
        if (count > max) allowed = false;
      }
      if (!allowed) await this.audit.write(tx, 'auth.rate', 'denied');
      return allowed;
    });
    if (!ok) throw new AppError(429, 'ADMIN_RATE_LIMIT', 'Too many authentication attempts');
  }
  private async challenge(tx: DbTransaction, account: AdminAccount) {
    const raw = token();
    const expiresAt = new Date(Date.now() + 600000);
    await tx.adminChallenge.create({
      data: {
        tokenHash: digest(raw),
        accountId: account.id,
        authVersion: account.authVersion,
        expiresAt,
      },
    });
    const secret =
      account.status === 'pending'
        ? decryptSecret(account.encryptedMfaSecret, this.config.admin!.encryptionKey!, account.id)
        : undefined;
    return {
      raw,
      data: {
        next: secret ? ('enroll' as const) : ('mfa' as const),
        expiresAt: expiresAt.toISOString(),
        ...(secret
          ? {
              secret,
              otpauthUri: `otpauth://totp/ViviAI:${encodeURIComponent(account.email)}?secret=${secret}&issuer=ViviAI&algorithm=SHA1&digits=6&period=30`,
            }
          : {}),
      },
    };
  }
  private async afterPassword(tx: DbTransaction, account: AdminAccount, ip: string) {
    if (!allowsLocalPasswordLogin(this.config, account.email, ip))
      return this.challenge(tx, account);
    const raw = token();
    const session = await tx.adminSession.create({
      data: {
        tokenHash: digest(raw),
        accountId: account.id,
        authVersion: account.authVersion,
        authMethod: 'local_password',
        expiresAt: new Date(Date.now() + 8 * 3600000),
      },
    });
    // Password-only testing must never mark an account as MFA-enrolled.
    await tx.adminChallenge.deleteMany({ where: { accountId: account.id } });
    await this.audit.write(tx, 'auth.local_password', 'allowed', account.id, session.id);
    return {
      raw,
      data: {
        account: actor(account, session, await this.permissionService.account(tx, account.id)),
      },
    };
  }
  async login(email: string, password: string, ip: string) {
    this.enabled();
    this.passwordMinimum(password, email, ip);
    await this.rate(ip, email);
    const result = await this.db.transaction(async (tx) => {
      await lockTeam(tx);
      await lockAdmin(tx, `email:${email}`);
      const initial = await tx.adminAccount.findUnique({ where: { email } });
      if (initial) await lockAdmin(tx, initial.id);
      const account = initial
        ? await tx.adminAccount.findUnique({ where: { id: initial.id } })
        : null;
      const valid = await verifyPassword(password, account?.passwordHash);
      if (
        !account ||
        !valid ||
        account.disabledAt ||
        !['active', 'pending'].includes(account.status) ||
        !(await this.permissionService.account(tx, account.id)).permissions.length
      ) {
        await this.audit.write(tx, 'auth.login', 'denied', account?.id);
        return null;
      }
      await this.audit.write(tx, 'auth.login', 'allowed', account.id);
      return this.afterPassword(tx, account, ip);
    });
    if (!result) throw denied();
    return result;
  }
  async accept(
    input: { token: string; email: string; displayName: string; password: string },
    ip: string,
  ) {
    this.enabled();
    const minimum = this.passwordMinimum(input.password, input.email, ip);
    await this.rate(ip, input.email);
    const passwordHash = await hashPassword(input.password, minimum);
    const result = await this.db.transaction(async (tx) => {
      await lockTeam(tx);
      await lockAdmin(tx, `email:${input.email}`);
      await lockAdmin(tx, `invitation:${digest(input.token)}`);
      const invite = await tx.adminInvitation.findUnique({
        where: { tokenHash: digest(input.token) },
        include: roleInclude,
      });
      if (
        !invite ||
        invite.email !== input.email ||
        invite.consumedAt ||
        invite.revokedAt ||
        !this.permissionService.resolve(invite.roleBindings, invite.extraPermissions).permissions
          .length ||
        invite.roleBindings.some((b) => b.roleKey === 'super_admin') ||
        invite.expiresAt <= new Date() ||
        (await tx.adminAccount.findUnique({ where: { email: input.email } }))
      ) {
        await this.audit.write(tx, 'invitation.accept', 'denied');
        return null;
      }
      const id = randomUUID();
      const account = await tx.adminAccount.create({
        data: {
          id,
          email: input.email,
          displayName: input.displayName,
          passwordHash,
          status: 'pending',
          roleBindings: { create: invite.roleBindings.map((b) => ({ roleKey: b.roleKey })) },
          extraPermissions: invite.extraPermissions,
          encryptedMfaSecret: encryptSecret(newSecret(), this.config.admin!.encryptionKey!, id),
        },
      });
      await tx.adminInvitation.update({
        where: { id: invite.id },
        data: { consumedAt: new Date(), version: { increment: 1 } },
      });
      await this.audit.write(tx, 'invitation.accept', 'allowed', id, undefined, invite.id);
      return this.afterPassword(tx, account, ip);
    });
    if (!result) throw denied();
    return result;
  }
  async verify(raw: string, method: 'totp' | 'recovery', code: string, ip: string) {
    this.enabled();
    await this.rate(ip, `mfa:${digest(raw)}`, 30);
    const initial = /^[\w-]{43}$/.test(raw)
      ? await this.db.client.adminChallenge.findUnique({ where: { tokenHash: digest(raw) } })
      : null;
    if (!initial) throw denied();
    const result = await this.db.transaction(async (tx) => {
      await lockTeam(tx);
      await lockAdmin(tx, initial.accountId);
      const challenge = await tx.adminChallenge.findUnique({ where: { id: initial.id } });
      const account = await tx.adminAccount.findUnique({ where: { id: initial.accountId } });
      if (
        !account ||
        !challenge ||
        account.disabledAt ||
        !(await this.permissionService.account(tx, account.id)).permissions.length ||
        challenge.expiresAt <= new Date() ||
        challenge.attempts >= 5 ||
        challenge.authVersion !== account.authVersion ||
        !['active', 'pending'].includes(account.status)
      ) {
        await this.audit.write(tx, 'mfa.verify', 'denied', initial.accountId);
        return null;
      }
      let valid = false;
      if (method === 'totp') {
        const counter = verifyTotp(
          decryptSecret(account.encryptedMfaSecret, this.config.admin!.encryptionKey!, account.id),
          code,
          Date.now(),
          account.lastTotpCounter,
        );
        if (counter !== null) {
          await tx.adminAccount.update({
            where: { id: account.id },
            data: { lastTotpCounter: counter },
          });
          valid = true;
        }
      } else if (account.status === 'active' && /^[a-f0-9]{32}$/.test(code)) {
        const consumed = await tx.adminRecoveryCode.updateMany({
          where: { accountId: account.id, codeHash: digest(code), consumedAt: null },
          data: { consumedAt: new Date() },
        });
        valid = consumed.count === 1;
      }
      if (!valid) {
        await tx.adminChallenge.update({
          where: { id: challenge.id },
          data: { attempts: { increment: 1 } },
        });
        await this.audit.write(tx, 'mfa.verify', 'denied', account.id);
        return null;
      }
      let codes: string[] | undefined;
      if (account.status === 'pending') {
        codes = recoveryCodes();
        await tx.adminRecoveryCode.createMany({
          data: codes.map((code) => ({ accountId: account.id, codeHash: digest(code) })),
        });
        await tx.adminAccount.update({
          where: { id: account.id },
          data: { status: 'active', version: { increment: 1 } },
        });
      }
      const sessionRaw = token();
      const session = await tx.adminSession.create({
        data: {
          tokenHash: digest(sessionRaw),
          accountId: account.id,
          authVersion: account.authVersion,
          expiresAt: new Date(Date.now() + 8 * 3600000),
        },
      });
      await tx.adminChallenge.deleteMany({ where: { accountId: account.id } });
      await this.audit.write(tx, 'mfa.verify', 'allowed', account.id, session.id);
      return {
        raw: sessionRaw,
        data: {
          account: actor(account, session, await this.permissionService.account(tx, account.id)),
          ...(codes ? { recoveryCodes: codes } : {}),
        },
      };
    });
    if (!result) throw denied();
    return result;
  }
  async resolve(raw: string, ip = 'unknown'): Promise<AdminContext> {
    this.enabled();
    if (!/^[\w-]{43}$/.test(raw)) throw denied();
    const session = await this.db.client.adminSession.findUnique({
      where: { tokenHash: digest(raw) },
    });
    if (!session) throw denied();
    return this.db.transaction(async (tx) => {
      await lockTeam(tx);
      await lockAdmin(tx, session.accountId);
      const context = await this.reauthorize(tx, session.id, session.accountId, ip);
      await tx.adminSession.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } });
      return context;
    });
  }
  async reauthorize(
    tx: DbTransaction,
    sessionId: string,
    accountId: string,
    ip = 'unknown',
  ): Promise<AdminContext> {
    const session = await tx.adminSession.findUnique({ where: { id: sessionId } });
    const account = await tx.adminAccount.findUnique({ where: { id: accountId } });
    if (
      !session ||
      !account ||
      account.disabledAt ||
      session.accountId !== account.id ||
      (session.authMethod === 'local_password'
        ? !['active', 'pending'].includes(account.status) ||
          !allowsLocalPasswordLogin(this.config, account.email, ip)
        : session.authMethod !== 'mfa' || account.status !== 'active') ||
      session.authVersion !== account.authVersion ||
      session.expiresAt <= new Date() ||
      session.createdAt.getTime() + 8 * 3600000 <= Date.now() ||
      session.lastSeenAt.getTime() + 30 * 60000 <= Date.now() ||
      !(await this.permissionService.account(tx, account.id)).permissions.length
    )
      throw denied();
    return {
      actor: actor(account, session, await this.permissionService.account(tx, account.id)),
      sessionId,
      requestIp: ip,
    };
  }
  async logout(sessionRaw: string, challengeRaw: string) {
    this.enabled();
    await this.db.transaction(async (tx) => {
      await lockTeam(tx);
      const session = await tx.adminSession.findUnique({
        where: { tokenHash: digest(sessionRaw) },
      });
      if (session) {
        await lockAdmin(tx, session.accountId);
        await this.audit.write(tx, 'auth.logout', 'allowed', session.accountId, session.id);
      }
      await tx.adminSession.updateMany({
        where: { tokenHash: digest(sessionRaw) },
        data: { expiresAt: new Date(0) },
      });
      await tx.adminChallenge.deleteMany({ where: { tokenHash: digest(challengeRaw) } });
    });
    return { success: true };
  }
}
