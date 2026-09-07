import { Module } from '@nestjs/common';
import { WalletModule } from '../wallet/wallet.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { BILLING_RUNTIME, BillingService } from './billing.service.js';
import { BillingController, PaymentWebhookController } from './billing.controller.js';
import { loadBillingRuntime } from './config.js';
@Module({
  imports: [WalletModule, IdentityModule],
  controllers: [BillingController, PaymentWebhookController],
  providers: [BillingService, { provide: BILLING_RUNTIME, useFactory: () => loadBillingRuntime() }],
  exports: [BillingService],
})
export class BillingModule {}
