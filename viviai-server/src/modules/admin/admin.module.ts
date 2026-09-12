import { Module } from '@nestjs/common';
import { AdminModelPricingController } from './model-pricing/controller.js';
import { AdminModelPricingService } from './model-pricing/service.js';
import { AdminPermissionService } from './permission.service.js';
import { AdminTeamCommands } from './team/command.service.js';
import { AdminTeamController } from './team/team.controller.js';
import { AdminInvitationsService } from './team/invitations.service.js';
import { AdminMembersService } from './team/members.service.js';
import { AdminRolesService } from './team/roles.service.js';
import { AdminPasswordResetService } from './team/password-reset.service.js';
import { AdminPasswordResetController } from './team/password-reset.controller.js';
import { AdminAuditService } from './audit.service.js';
import { AdminAuthService } from './auth.service.js';
import { AdminAuthController } from './auth.controller.js';
import { AdminSessionGuard } from './session.guard.js';
import { AdminQueryController } from './query.controller.js';
import { AdminQueryService } from './query.service.js';
import { AssetsModule } from '../assets/assets.module.js';
import { AdminSensitiveController } from './sensitive.controller.js';
import { AdminSensitiveService } from './sensitive.service.js';
import { AdminProviderVerificationController } from './provider-verification.controller.js';
import { AdminProviderVerificationService } from './provider-verification.service.js';
import { AdminContentController } from './content/content.controller.js';
import { AdminContentService } from './content/content.service.js';
import { AdminContentMediaService } from './content/media.service.js';
import { AdminContentCommands } from './content/command.service.js';
import { AdminContentPublishValidator } from './content/publish-validator.js';
@Module({
  imports: [AssetsModule],
  controllers: [
    AdminModelPricingController,
    AdminAuthController,
    AdminQueryController,
    AdminSensitiveController,
    AdminTeamController,
    AdminPasswordResetController,
    AdminProviderVerificationController,
    AdminContentController,
  ],
  providers: [
    AdminModelPricingService,
    AdminPermissionService,
    AdminTeamCommands,
    AdminInvitationsService,
    AdminMembersService,
    AdminRolesService,
    AdminPasswordResetService,
    AdminAuditService,
    AdminAuthService,
    AdminSessionGuard,
    AdminQueryService,
    AdminSensitiveService,
    AdminProviderVerificationService,
    AdminContentService,
    AdminContentMediaService,
    AdminContentCommands,
    AdminContentPublishValidator,
  ],
})
export class AdminModule {}
