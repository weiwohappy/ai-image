import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { parse } from '../auth.controller.js';
import { AdminSessionGuard, type AdminRequest } from '../session.guard.js';
import { AdminMarketingService } from './marketing.service.js';

@Controller('admin')
@UseGuards(AdminSessionGuard)
export class AdminMarketingController {
  constructor(@Inject(AdminMarketingService) private readonly marketing: AdminMarketingService) {}

  @Get('redemption-campaigns')
  campaigns(@Req() request: AdminRequest, @Query() query: unknown) {
    return this.marketing.listCampaigns(request.admin, query);
  }

  @Get('redemption-campaigns/:id')
  campaign(@Req() request: AdminRequest, @Param('id') id: string, @Query() query: unknown) {
    parse(z.object({}).strict(), query);
    return this.marketing.campaign(request.admin, id);
  }

  @Post('redemption-campaigns')
  createCampaign(@Req() request: AdminRequest, @Body() body: unknown) {
    return this.marketing.createCampaign(request.admin, request.get('Idempotency-Key') ?? '', body);
  }

  @Patch('redemption-campaigns/:id')
  updateCampaign(@Req() request: AdminRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.marketing.updateCampaign(
      request.admin,
      request.get('Idempotency-Key') ?? '',
      id,
      body,
    );
  }

  @Post('redemption-campaigns/:id/disable')
  disableCampaign(@Req() request: AdminRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.marketing.disableCampaign(
      request.admin,
      request.get('Idempotency-Key') ?? '',
      id,
      body,
    );
  }

  @Post('redemption-campaigns/:id/archive')
  archiveCampaign(@Req() request: AdminRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.marketing.archiveCampaign(
      request.admin,
      request.get('Idempotency-Key') ?? '',
      id,
      body,
    );
  }

  @Get('redemption-codes')
  codes(@Req() request: AdminRequest, @Query() query: unknown) {
    return this.marketing.listCodes(request.admin, query);
  }

  @Get('redemption-codes/:id')
  code(@Req() request: AdminRequest, @Param('id') id: string, @Query() query: unknown) {
    parse(z.object({}).strict(), query);
    return this.marketing.code(request.admin, id);
  }

  @Post('redemption-codes')
  generateCodes(@Req() request: AdminRequest, @Body() body: unknown) {
    return this.marketing.generateCodes(request.admin, request.get('Idempotency-Key') ?? '', body);
  }

  @Post('redemption-codes/:id/disable')
  disableCode(@Req() request: AdminRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.marketing.disableCode(
      request.admin,
      request.get('Idempotency-Key') ?? '',
      id,
      body,
    );
  }

  @Get('redemption-claims')
  claims(@Req() request: AdminRequest, @Query() query: unknown) {
    return this.marketing.listClaims(request.admin, query);
  }

  @Get('referrals')
  referrals(@Req() request: AdminRequest, @Query() query: unknown) {
    return this.marketing.listReferrals(request.admin, query);
  }
}
