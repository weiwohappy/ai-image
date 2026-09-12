import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { DatabaseService } from '../../shared/database/database.service.js';
import { AppError } from '../../shared/http/errors.js';
import { lockUserAuth } from '../../shared/database/locks.js';
import { EmailChallengeService, type ChallengePurpose } from './challenge.service.js';
import { ReferralService } from '../engagement/referral.service.js';

const derive = promisify(scrypt);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const sessionTokenHash = digest;
export function inviteCodeCandidate(email: string, username: string, attempt: number): string {
  return createHash('sha256')
    .update(`${email}:${username}:${attempt}`)
    .digest('hex')
    .slice(0, 8)
    .toUpperCase();
}
export interface PublicAccount {
  id: string;
  email: string;
  username: string;
  avatarAssetId: string | null;
  inviteCode: string;
  authVersion: number;
}
export const SESSION_COOKIE = 'viviai_session';
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const hash = (await derive(password, salt, 64)) as Buffer;
  return `${salt}:${hash.toString('hex')}`;
}
async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, expected] = stored.split(':');
  if (!salt || !expected) return false;
  const actual = (await derive(password, salt, 64)) as Buffer;
  const expectedBytes = Buffer.from(expected, 'hex');
  return expectedBytes.length === actual.length && timingSafeEqual(actual, expectedBytes);
}
export function accountDto(user: PublicAccount) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    planId: 'free' as const,
    planName: 'Free' as const,
    credits: 0,
    frozenCredits: 0,
    concurrency: 1 as const,
    ...(user.avatarAssetId ? { avatarUrl: `/api/assets/${user.avatarAssetId}/content` } : {}),
    inviteCode: user.inviteCode,
  };
}

@Injectable()
export class IdentityService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EmailChallengeService) private readonly challenges: EmailChallengeService,
    @Inject(ReferralService) private readonly referrals: ReferralService,
  ) {}

  async rateLimit(operation: string, credential: string, ip: string): Promise<void> {
    // Durable counters work across processes; raw credentials/IPs are not stored.
    for (const [key, limit] of [
      [`${operation}:credential:${digest(credential)}`, 20],
      [`${operation}:ip:${digest(ip)}`, 100],
    ] as const) {
      const allowed = await this.db.transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`rate:${key}`}, 0))`;
        const bucket = await tx.authRateBucket.findUnique({ where: { key } });
        const expired = !bucket || bucket.expiresAt.getTime() <= Date.now();
        if (!expired && bucket.count >= limit) return false;
        await tx.authRateBucket.upsert({
          where: { key },
          create: { key, count: 1, expiresAt: new Date(Date.now() + 15 * 60_000) },
          update: expired
            ? { count: 1, expiresAt: new Date(Date.now() + 15 * 60_000) }
            : { count: { increment: 1 } },
        });
        return true;
      });
      if (!allowed) throw new AppError(429, 'RATE_LIMITED', 'Too many attempts; try again later');
    }
  }

  async sendCode(email: string, purpose: ChallengePurpose): Promise<{ expiresIn: number }> {
    return this.challenges.send(email, purpose);
  }

  async register(input: {
    email: string;
    username: string;
    password: string;
    code: string;
    inviteCode?: string | undefined;
  }): Promise<PublicAccount> {
    const passwordHash = await hashPassword(input.password);
    try {
      return await this.challenges.consume(input.email, 'register', input.code, async (tx) => {
        const user = await tx.user.create({
          data: { email: input.email, username: input.username, passwordHash },
          select: {
            id: true,
            email: true,
            username: true,
            avatarAssetId: true,
            inviteCode: true,
            authVersion: true,
          },
        });
        let assigned: PublicAccount | null = null;
        for (let attempt = 0; attempt < 32; attempt++) {
          const inviteCode = inviteCodeCandidate(input.email, input.username, attempt);
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`invite-code:${inviteCode}`}, 0))`;
          if (await tx.user.findUnique({ where: { inviteCode }, select: { id: true } })) continue;
          assigned = await tx.user.update({
            where: { id: user.id },
            data: { inviteCode },
            select: {
              id: true,
              email: true,
              username: true,
              avatarAssetId: true,
              inviteCode: true,
              authVersion: true,
            },
          });
          break;
        }
        if (!assigned)
          throw new AppError(503, 'INVITE_CODE_UNAVAILABLE', 'Invite code is unavailable');
        await this.referrals.bindAtRegistration(tx, assigned.id, input.inviteCode);
        return assigned;
      });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'P2002' &&
        'meta' in error &&
        typeof error.meta === 'object' &&
        error.meta !== null &&
        'target' in error.meta &&
        Array.isArray(error.meta.target) &&
        error.meta.target.some((target) => target === 'email' || target === 'username')
      )
        throw new AppError(409, 'ACCOUNT_EXISTS', 'Email or username is already registered');
      throw error;
    }
  }
  async login(account: string, password: string): Promise<PublicAccount> {
    const user = await this.db.client.user.findFirst({
      where: { OR: [{ email: account }, { username: account }] },
    });
    // Equal-cost missing-account path avoids a cheap password timing oracle.
    const valid = await verifyPassword(
      password,
      user?.passwordHash ?? `${'0'.repeat(32)}:${'0'.repeat(128)}`,
    );
    if (!user || !valid)
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Account or password is incorrect');
    return {
      id: user.id,
      email: user.email,
      username: user.username,
      avatarAssetId: user.avatarAssetId,
      inviteCode: user.inviteCode,
      authVersion: user.authVersion,
    };
  }
  async resetPassword(email: string, code: string, password: string): Promise<{ success: true }> {
    const passwordHash = await hashPassword(password);
    await this.challenges.consume(email, 'reset-password', code, async (tx) => {
      const user = await tx.user.findUnique({ where: { email } });
      if (!user) throw new AppError(400, 'INVALID_CODE', 'Verification code is invalid or expired');
      await lockUserAuth(tx, user.id);
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash, authVersion: { increment: 1 } },
      });
      await tx.session.deleteMany({ where: { userId: user.id } });
    });
    return { success: true };
  }
  async createSession(userId: string, expectedAuthVersion: number): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.db.transaction(async (tx) => {
      await lockUserAuth(tx, userId);
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { authVersion: true },
      });
      if (!user || user.authVersion !== expectedAuthVersion)
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Account or password is incorrect');
      await tx.session.create({
        data: {
          userId,
          tokenHash: digest(token),
          authVersion: user.authVersion,
          expiresAt: new Date(Date.now() + SESSION_MAX_AGE_MS),
        },
      });
    });
    return token;
  }
  async resolveSession(token: string): Promise<PublicAccount | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const session = await this.db.client.session.findUnique({
      where: { tokenHash: digest(token) },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            username: true,
            avatarAssetId: true,
            inviteCode: true,
            authVersion: true,
          },
        },
      },
    });
    return session &&
      session.expiresAt.getTime() > Date.now() &&
      session.authVersion === session.user.authVersion
      ? session.user
      : null;
  }
  async logout(token: string): Promise<void> {
    await this.db.client.session.deleteMany({ where: { tokenHash: digest(token) } });
  }
}
