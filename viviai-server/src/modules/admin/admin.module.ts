import { Module } from '@nestjs/common';
import { AdminAuditService } from './audit.service.js';
import { AdminAuthService } from './auth.service.js';
import { AdminAuthController } from './auth.controller.js';
import { AdminSessionGuard } from './session.guard.js';
import { AdminQueryController } from './query.controller.js';
import { AdminQueryService } from './query.service.js';
import { AssetsModule } from '../assets/assets.module.js';
import { AdminSensitiveController } from './sensitive.controller.js';
import { AdminSensitiveService } from './sensitive.service.js';
@Module({
  imports: [AssetsModule],
  controllers: [AdminAuthController, AdminQueryController, AdminSensitiveController],
  providers: [
    AdminAuditService,
    AdminAuthService,
    AdminSessionGuard,
    AdminQueryService,
    AdminSensitiveService,
  ],
})
export class AdminModule {}
