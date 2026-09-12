import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service.js';
import { AppError } from '../../shared/http/errors.js';
import { safeInteger } from '../../shared/database/locks.js';
import {
  accountDto,
  hashPassword,
  type PublicAccount,
} from '../identity/identity.service.js';
import { EmailChallengeService } from '../identity/challenge.service.js';
import { WalletService } from '../wallet/wallet.service.js';

export interface AccountDto {
  id: string;
  username: string;
  email: string;
  avatarUrl?: string;
  planId: 'free';
  planName: 'Free';
  credits: number;
  frozenCredits: number;
  concurrency: number;
  inviteCode: string;
}

const userSelect = {
  id: true,
  email: true,
  username: true,
  avatarAssetId: true,
  inviteCode: true,
} as const;

@Injectable()
export class AccountService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(EmailChallengeService) private readonly challenges: EmailChallengeService,
    @Inject(WalletService) private readonly wallet: WalletService,
  ) {}

  async publicAccount(user: PublicAccount): Promise<AccountDto> {
    const balance = await this.wallet.balance(user.id);
    return {
      ...accountDto(user),
      credits: safeInteger(balance.available),
      frozenCredits: safeInteger(balance.held),
    };
  }

  async updateProfile(userId: string, input: { username: string }): Promise<AccountDto> {
    try {
      const user = await this.db.client.user.update({
        where: { id: userId },
        data: { username: input.username },
        select: userSelect,
      });
      return this.publicAccount(user);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002')
        throw new AppError(409, 'USERNAME_TAKEN', 'Username is already registered');
      throw error;
    }
  }

  async changeEmail(
    userId: string,
    currentTokenHash: string,
    input: { email: string; code: string },
  ): Promise<AccountDto> {
    try {
      const user = await this.challenges.consume(input.email, 'change-email', input.code, async (tx) => {
        const updated = await tx.user.update({
          where: { id: userId },
          data: { email: input.email },
          select: userSelect,
        });
        await tx.session.deleteMany({ where: { userId, tokenHash: { not: currentTokenHash } } });
        return updated;
      });
      return this.publicAccount(user);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002')
        throw new AppError(409, 'EMAIL_TAKEN', 'Email is already registered');
      throw error;
    }
  }

  async changePassword(
    user: PublicAccount,
    currentTokenHash: string,
    input: { password: string; code: string },
  ): Promise<AccountDto> {
    const passwordHash = await hashPassword(input.password);
    const updated = await this.challenges.consume(
      user.email,
      'change-password',
      input.code,
      async (tx) => {
        const result = await tx.user.update({
          where: { id: user.id },
          data: { passwordHash },
          select: userSelect,
        });
        await tx.session.deleteMany({
          where: { userId: user.id, tokenHash: { not: currentTokenHash } },
        });
        return result;
      },
    );
    return this.publicAccount(updated);
  }
}
