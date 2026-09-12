import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { WalletModule } from '../wallet/wallet.module.js';
import { AccountController } from './account.controller.js';
import { AccountService } from './account.service.js';

@Module({
  imports: [IdentityModule, WalletModule],
  controllers: [AccountController],
  providers: [AccountService],
  exports: [AccountService],
})
export class AccountModule {}
