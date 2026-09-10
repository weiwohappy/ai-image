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
@Module({
  imports: [AssetsModule],
  controllers: [
    AdminModelPricingController,
    AdminAuthController,
    AdminQueryController,
    AdminSensitiveController,
    AdminTeamController,
    AdminPasswordResetController,
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
  ],
})
export class AdminModule {}
