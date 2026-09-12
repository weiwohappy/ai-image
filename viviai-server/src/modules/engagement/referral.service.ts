import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService, type DbTransaction } from '../../shared/database/database.service.js';
import { AppError } from '../../shared/http/errors.js';
import { WalletService } from '../wallet/wallet.service.js';
import { NotificationService } from './notification.service.js';

const INVITE_REWARD = 100n;

@Injectable()
export class ReferralService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(WalletService) private readonly wallet: WalletService,
    @Inject(NotificationService) private readonly notifications: NotificationService,
  ) {}

  async bindAtRegistration(tx: DbTransaction, inviteeUserId: string, inviteCode?: string) {
    if (!inviteCode) return null;
    const inviter = await tx.user.findUnique({ where: { inviteCode } });
    if (!inviter || inviter.id === inviteeUserId)
      throw new AppError(422, 'INVALID_INVITE_CODE', 'Invite code is invalid');
    const existing = await tx.referral.findUnique({ where: { inviteeUserId } });
    if (existing) {
      if (existing.inviterUserId !== inviter.id)
        throw new AppError(422, 'INVALID_INVITE_CODE', 'Invite code is invalid');
      return existing;
    }
    const referral = await tx.referral.create({
      data: {
        inviterUserId: inviter.id,
        inviteeUserId,
        status: 'rewarded',
        rewardCredits: Number(INVITE_REWARD),
        qualifiedAt: new Date(),
        rewardedAt: new Date(),
      },
    });
    await tx.user.update({ where: { id: inviteeUserId }, data: { invitedByUserId: inviter.id } });
    await this.wallet.grant(tx, inviter.id, `invite:inviter:${referral.id}`, INVITE_REWARD, null);
    await this.wallet.grant(
      tx,
      inviteeUserId,
      `invite:invitee:${referral.id}`,
      INVITE_REWARD,
      null,
    );
    await this.notifications.create(tx, {
      userId: inviter.id,
      type: 'credits',
      title: '邀请奖励到账',
      body: `好友注册成功，${Number(INVITE_REWARD)} 积分已到账。`,
      action: { href: '/invite' },
    });
    await this.notifications.create(tx, {
      userId: inviteeUserId,
      type: 'credits',
      title: '邀请奖励到账',
      body: `${Number(INVITE_REWARD)} 积分已到账。`,
      action: { href: '/account' },
    });
    return referral;
  }

  async listForInviter(userId: string) {
    const rows = await this.db.client.referral.findMany({
      where: { inviterUserId: userId },
      include: { invitee: { select: { username: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 200,
    });
    return rows.map((row) => ({
      id: row.id,
      username: row.invitee.username,
      reward: row.rewardCredits,
      status: row.status === 'rewarded' ? 'rewarded' : 'pending',
      createdAt: row.createdAt.toISOString(),
    }));
  }
}
