import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { WalletModule } from '../wallet/wallet.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { GenerationService } from './generation.service.js';
import { GenerationController } from './generation.controller.js';
@Module({
  imports: [IdentityModule, WalletModule, CatalogModule],
  controllers: [GenerationController],
  providers: [GenerationService],
  exports: [GenerationService],
})
export class GenerationModule {}
