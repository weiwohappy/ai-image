import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { DatabaseService, type DbTransaction } from '../../shared/database/database.service.js';
import { AppError } from '../../shared/http/errors.js';
import { MAIL_DELIVERY, type MailDelivery } from './mail-delivery.js';

const derive = promisify(scrypt);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export interface PublicAccount {
  id: string;
  email: string;
  username: string;
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
    planId: 'free',
    planName: 'Free',
    credits: 0,
    frozenCredits: 0,
    concurrency: 1,
    inviteCode: '',
  };
}
const challengeError = () =>
  new AppError(400, 'INVALID_CODE', 'Verification code is invalid or expired');
async function lock(tx: DbTransaction, key: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

@Injectable()
export class IdentityService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(MAIL_DELIVERY) private readonly mail: MailDelivery,
  ) {}

  async rateLimit(operation: string, credential: string, ip: string): Promise<void> {
    // Durable counters work across processes; raw credentials/IPs are not stored.
    for (const [key, limit] of [
      [`${operation}:credential:${digest(credential)}`, 20],
      [`${operation}:ip:${digest(ip)}`, 100],
    ] as const) {
      const allowed = await this.db.transaction(async (tx) => {
        await lock(tx, `rate:${key}`);
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

  async sendCode(
    email: string,
    purpose: 'register' | 'reset-password',
  ): Promise<{ expiresIn: number }> {
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const salt = randomBytes(16).toString('hex');
    // Scrypt protects low-entropy codes if a database snapshot is exposed.
    const codeHash = ((await derive(code, salt, 64)) as Buffer).toString('hex');
    await this.db.transaction(async (tx) => {
      await lock(tx, `challenge:${email}:${purpose}`);
      const existing = await tx.emailChallenge.findUnique({
        where: { email_purpose: { email, purpose } },
      });
      if (existing && existing.sentAt.getTime() > Date.now() - 60_000)
        throw new AppError(429, 'RATE_LIMITED', 'Please wait before requesting another code');
      const data = {
        codeHash,
        salt,
        attempts: 0,
        sentAt: new Date(),
        expiresAt: new Date(Date.now() + 600_000),
        consumedAt: null,
      };
      await tx.emailChallenge.upsert({
        where: { email_purpose: { email, purpose } },
        create: { email, purpose, ...data },
        update: data,
      });
    });
    try {
      await this.mail.sendChallenge({ email, purpose, code });
    } catch {
      throw new AppError(503, 'MAIL_UNAVAILABLE', 'Verification delivery is unavailable');
    }
    return { expiresIn: 600 };
  }

  private async consume<T>(
    email: string,
    purpose: string,
    code: string,
    action: (tx: DbTransaction) => Promise<T>,
  ): Promise<T> {
    const result = await this.db.transaction(async (tx) => {
      await lock(tx, `challenge:${email}:${purpose}`);
      const challenge = await tx.emailChallenge.findUnique({
        where: { email_purpose: { email, purpose } },
      });
      if (
        !challenge ||
        challenge.consumedAt ||
        challenge.expiresAt.getTime() <= Date.now() ||
        challenge.attempts >= 5
      )
        return { error: true } as const;
      const actual = (await derive(code, challenge.salt, 64)) as Buffer;
      if (!timingSafeEqual(actual, Buffer.from(challenge.codeHash, 'hex'))) {
        await tx.emailChallenge.update({
          where: { email_purpose: { email, purpose } },
          data: { attempts: { increment: 1 } },
        });
        return { error: true } as const;
      }
      await tx.emailChallenge.update({
        where: { email_purpose: { email, purpose } },
        data: { consumedAt: new Date() },
      });
      return { value: await action(tx) } as const;
    });
    if ('error' in result) throw challengeError();
    return result.value;
  }

  async register(input: {
    email: string;
    username: string;
    password: string;
    code: string;
  }): Promise<PublicAccount> {
    const passwordHash = await hashPassword(input.password);
    try {
      return await this.consume(input.email, 'register', input.code, (tx) =>
        tx.user.create({
          data: { email: input.email, username: input.username, passwordHash },
          select: { id: true, email: true, username: true },
        }),
      );
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002')
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
    return { id: user.id, email: user.email, username: user.username };
  }
  async resetPassword(email: string, code: string, password: string): Promise<{ success: true }> {
    const passwordHash = await hashPassword(password);
    await this.consume(email, 'reset-password', code, async (tx) => {
      const user = await tx.user.findUnique({ where: { email } });
      if (!user) throw challengeError();
      await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
      await tx.session.deleteMany({ where: { userId: user.id } });
    });
    return { success: true };
  }
  async createSession(userId: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.db.client.session.create({
      data: {
        userId,
        tokenHash: digest(token),
        expiresAt: new Date(Date.now() + SESSION_MAX_AGE_MS),
      },
    });
    return token;
  }
  async resolveSession(token: string): Promise<PublicAccount | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const session = await this.db.client.session.findUnique({
      where: { tokenHash: digest(token) },
      include: { user: { select: { id: true, email: true, username: true } } },
    });
    return session && session.expiresAt.getTime() > Date.now() ? session.user : null;
  }
  async logout(token: string): Promise<void> {
    await this.db.client.session.deleteMany({ where: { tokenHash: digest(token) } });
  }
}
