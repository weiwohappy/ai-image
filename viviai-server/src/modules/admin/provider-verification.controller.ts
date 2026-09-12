import { Controller, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AdminSessionGuard, type AdminRequest } from './session.guard.js';
import { AdminProviderVerificationService } from './provider-verification.service.js';

@Controller('admin/provider-accounts')
@UseGuards(AdminSessionGuard)
export class AdminProviderVerificationController {
  constructor(
    @Inject(AdminProviderVerificationService)
    private readonly verification: AdminProviderVerificationService,
  ) {}

  @Post(':id/verify') verify(@Req() request: AdminRequest, @Param('id') id: string) {
    return this.verification.verify(request.admin.actor, id);
  }
}
