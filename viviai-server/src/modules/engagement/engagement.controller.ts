import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { parseInput } from '../identity/identity.controller.js';
import { SessionGuard, type AuthenticatedRequest } from '../identity/session.guard.js';
import { NotificationService } from './notification.service.js';
import { RedemptionService } from './redemption.service.js';
import { ReferralService } from './referral.service.js';

@Controller()
@UseGuards(SessionGuard)
export class EngagementController {
  constructor(
    @Inject(NotificationService) private readonly notifications: NotificationService,
    @Inject(ReferralService) private readonly referrals: ReferralService,
    @Inject(RedemptionService) private readonly redemption: RedemptionService,
  ) {}

  @Get('notifications') listNotifications(@Req() req: AuthenticatedRequest) {
    return this.notifications.list(req.userId);
  }
  @Post('notifications/read-all') markAllRead(@Req() req: AuthenticatedRequest) {
    return this.notifications.markAllRead(req.userId);
  }
  @Post('notifications/:id/read') markRead(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    return this.notifications.markRead(req.userId, id);
  }
  @Get('invites') listInvites(@Req() req: AuthenticatedRequest) {
    return this.referrals.listForInviter(req.userId);
  }
  @Post('account/redeem')
  async redeem(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string,
  ) {
    return this.redemption.claim(
      req.userId,
      parseInput(z.object({ code: z.string() }).strict(), body).code,
      key,
    );
  }
}
