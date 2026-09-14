import { Body, Controller, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { parse } from '../auth.controller.js';
import { AdminQueryService } from '../query.service.js';
import { AdminSessionGuard, type AdminRequest } from '../session.guard.js';
import { AdminBatchCommands } from './batch-commands.service.js';

@Controller('admin')
@UseGuards(AdminSessionGuard)
export class AdminWorkflowController {
  constructor(
    @Inject(AdminQueryService) private readonly queries: AdminQueryService,
    @Inject(AdminBatchCommands) private readonly batches: AdminBatchCommands,
  ) {}

  @Get('workflows')
  workflows(@Req() request: AdminRequest, @Query() query: unknown) {
    return this.queries.workflows(request.admin.actor, query);
  }

  @Get('workflows/:id')
  workflow(@Req() request: AdminRequest, @Param('id') id: string, @Query() query: unknown) {
    parse(z.object({}).strict(), query);
    return this.queries.workflow(request.admin.actor, id);
  }

  @Get('batches')
  list(@Req() request: AdminRequest, @Query() query: unknown) {
    return this.queries.batches(request.admin.actor, query);
  }

  @Get('batches/:id')
  batch(@Req() request: AdminRequest, @Param('id') id: string, @Query() query: unknown) {
    parse(z.object({}).strict(), query);
    return this.queries.batch(request.admin.actor, id, request.admin.actor.permissions);
  }

  @Post('batches/:id/cancel')
  cancel(@Req() request: AdminRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.batches.cancel(request.admin, request.get('Idempotency-Key') ?? '', id, body);
  }

  @Post('batches/:id/retry-failed')
  retryFailed(@Req() request: AdminRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.batches.retryFailed(request.admin, request.get('Idempotency-Key') ?? '', id, body);
  }
}
