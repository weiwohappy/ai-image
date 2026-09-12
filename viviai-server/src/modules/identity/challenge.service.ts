import { Inject, Injectable } from '@nestjs/common';
import { randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { DatabaseService, type DbTransaction } from '../../shared/database/database.service.js';
import { AppError } from '../../shared/http/errors.js';
import { MAIL_DELIVERY, type MailDelivery } from './mail-delivery.js';

const derive = promisify(scrypt);

export type ChallengePurpose =
  | 'register'
  | 'reset-password'
  | 'change-email'
  | 'change-password';

const challengeError = () =>
  new AppError(400, 'INVALID_CODE', 'Verification code is invalid or expired');

async function lock(tx: DbTransaction, key: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

@Injectable()
export class EmailChallengeService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(MAIL_DELIVERY) private readonly mail: MailDelivery,
  ) {}

  async send(email: string, purpose: ChallengePurpose): Promise<{ expiresIn: number }> {
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const salt = randomBytes(16).toString('hex');
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

  async consume<T>(
    email: string,
    purpose: ChallengePurpose,
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
}
