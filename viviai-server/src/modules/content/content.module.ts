import { Module } from '@nestjs/common';
import { AssetsModule } from '../assets/assets.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { PublicContentController } from './public-content.controller.js';
import { PublicContentService } from './public-content.service.js';

@Module({
  imports: [IdentityModule, AssetsModule],
  controllers: [PublicContentController],
  providers: [PublicContentService],
  exports: [PublicContentService],
})
export class ContentModule {}
