import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../shared/database/database.service.js';
import { lockWallet } from '../../shared/database/locks.js';
import { AppError } from '../../shared/http/errors.js';
import { WalletService } from '../wallet/wallet.service.js';
import { NotificationService } from './notification.service.js';
import { accountDto, type PublicAccount } from '../identity/identity.service.js';
import { safeInteger } from '../../shared/database/locks.js';

const digest = (code: string) => createHash('sha256').update(code).digest('hex');
type AccountSnapshot = ReturnType<typeof accountDto>;

@Injectable()
export class RedemptionService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(WalletService) private readonly wallet: WalletService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
  ) {}

  async claim(userId: string, code: string, idempotencyKey: string) {
    const normalized = code.trim().toUpperCase();
    if (
      !/^[A-Z0-9-]{4,64}$/.test(normalized) ||
      !/^[A-Za-z0-9_-]{16,100}$/.test(idempotencyKey ?? '')
    )
      throw new AppError(400, 'INVALID_INPUT', 'Redemption input or idempotency key is invalid');
    const codeDigest = digest(normalized);
    return this.db.transaction(async (tx) => {
      // All redemption operations acquire locks in this order: global key, wallet user, code, campaign.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`redemption:key:${idempotencyKey}`}, 0))`;
      const previous = await tx.redemptionClaim.findUnique({ where: { idempotencyKey } });
      if (previous) {
        const redemptionCode = await tx.redemptionCode.findUnique({
          where: { digest: codeDigest },
        });
        if (previous.userId !== userId || previous.codeId !== redemptionCode?.id)
          throw new AppError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'Idempotency key was used with different input',
          );
        if (!previous.responseSnapshot)
          throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'Replay result is unavailable');
        return previous.responseSnapshot as unknown as AccountSnapshot;
      }
      await lockWallet(tx, userId);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`redemption:code:${codeDigest}`}, 0))`;
      const redemptionCode = await tx.redemptionCode.findUnique({
        where: { digest: codeDigest },
        include: { campaign: true },
      });
      if (!redemptionCode)
        throw new AppError(
          422,
          'REDEMPTION_INVALID_OR_EXPIRED',
          'Redemption code is invalid or expired',
        );
      if (
        await tx.redemptionClaim.findUnique({
          where: { userId_codeId: { userId, codeId: redemptionCode.id } },
          select: { id: true },
        })
      )
        throw new AppError(422, 'REDEMPTION_LIMIT_REACHED', 'Redemption limit has been reached');
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`redemption:campaign:${redemptionCode.campaignId}`}, 0))`;
      const current = await tx.redemptionCode.findUniqueOrThrow({
        where: { id: redemptionCode.id },
        include: { campaign: true },
      });
      const now = new Date();
      if (
        current.status !== 'active' ||
        current.campaign.status !== 'active' ||
        current.campaign.startsAt > now ||
        current.campaign.endsAt <= now
      )
        throw new AppError(
          422,
          'REDEMPTION_INVALID_OR_EXPIRED',
          'Redemption code is invalid or expired',
        );
      const userClaims = await tx.redemptionClaim.count({
        where: { userId, code: { campaignId: current.campaignId } },
      });
      const campaignClaims = await tx.redemptionClaim.count({
        where: { code: { campaignId: current.campaignId } },
      });
      if (
        current.usedCount >= current.maxUses ||
        userClaims >= current.campaign.perUserLimit ||
        (current.campaign.totalLimit !== null && campaignClaims >= current.campaign.totalLimit)
      )
        throw new AppError(422, 'REDEMPTION_LIMIT_REACHED', 'Redemption limit has been reached');
      const claim = await tx.redemptionClaim.create({
        data: { userId, codeId: current.id, credits: current.campaign.credits, idempotencyKey },
      });
      await this.wallet.grant(tx, userId, `redeem:${claim.id}`, BigInt(claim.credits), null);
      await tx.redemptionCode.update({
        where: { id: current.id },
        data: { usedCount: { increment: 1 } },
      });
      await this.notifications.create(tx, {
        userId,
        type: 'credits',
        title: '兑换积分到账',
        body: `${claim.credits} 积分已到账。`,
        action: { href: '/account' },
      });
      const user = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          username: true,
          avatarAssetId: true,
          inviteCode: true,
          authVersion: true,
        },
      });
      const balance = await this.wallet.balanceInTransaction(tx, userId);
      const snapshot = {
        ...accountDto(user as PublicAccount),
        credits: safeInteger(balance.available),
        frozenCredits: safeInteger(balance.held),
      };
      await tx.redemptionClaim.update({
        where: { id: claim.id },
        data: { responseSnapshot: snapshot },
      });
      return snapshot;
    });
  }
}
