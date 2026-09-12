import { forwardRef, Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { WalletModule } from '../wallet/wallet.module.js';
import { EngagementController } from './engagement.controller.js';
import { NotificationService } from './notification.service.js';
import { RedemptionService } from './redemption.service.js';
import { ReferralService } from './referral.service.js';

@Module({
  imports: [WalletModule, forwardRef(() => IdentityModule)],
  controllers: [EngagementController],
  providers: [NotificationService, ReferralService, RedemptionService],
  exports: [ReferralService],
})
export class EngagementModule {}
