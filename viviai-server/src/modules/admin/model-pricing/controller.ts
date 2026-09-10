import { Body, Controller, Get, Inject, Param, Put, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminSessionGuard, type AdminRequest } from '../session.guard.js';
import { parse } from '../auth.controller.js';
import { savePriceSchema } from './contracts.js';
import { AdminModelPricingService } from './service.js';
@Controller('admin/model-pricing')
@UseGuards(AdminSessionGuard)
export class AdminModelPricingController {
  constructor(@Inject(AdminModelPricingService) readonly prices: AdminModelPricingService) {}
  @Get() list(@Req() r: AdminRequest, @Query() q: unknown) {
    return this.prices.list(r.admin, q);
  }
  @Get(':modelId/history') history(
    @Req() r: AdminRequest,
    @Param('modelId') id: string,
    @Query() q: unknown,
  ) {
    return this.prices.history(r.admin, id, q);
  }
  @Get(':modelId/:resolution') detail(
    @Req() r: AdminRequest,
    @Param('modelId') id: string,
    @Param('resolution') resolution: string,
    @Query() q: unknown,
  ) {
    parse(z.object({}).strict(), q);
    return this.prices.detail(r.admin, id, resolution);
  }
  @Put(':modelId/:resolution') save(
    @Req() r: AdminRequest,
    @Param('modelId') id: string,
    @Param('resolution') resolution: string,
    @Body() body: unknown,
    @Query() q: unknown,
  ) {
    parse(z.object({}).strict(), q);
    return this.prices.save(
      r.admin,
      r.get('Idempotency-Key') ?? '',
      id,
      resolution,
      parse(savePriceSchema, body),
    );
  }
}
