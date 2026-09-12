import { Module } from '@nestjs/common';
import type { AppConfig } from '../../config.js';
import { APP_CONFIG } from '../../shared/infrastructure.module.js';
import { IdentityService } from './identity.service.js';
import { IdentityController } from './identity.controller.js';
import { SessionGuard } from './session.guard.js';
import { createMailDelivery, MAIL_DELIVERY } from './mail-delivery.js';
import { WalletModule } from '../wallet/wallet.module.js';
import { EmailChallengeService } from './challenge.service.js';
@Module({
  imports: [WalletModule],
  controllers: [IdentityController],
  providers: [
    IdentityService,
    EmailChallengeService,
    SessionGuard,
    {
      provide: MAIL_DELIVERY,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createMailDelivery(config),
    },
  ],
  exports: [IdentityService, EmailChallengeService, SessionGuard, MAIL_DELIVERY],
})
export class IdentityModule {}
