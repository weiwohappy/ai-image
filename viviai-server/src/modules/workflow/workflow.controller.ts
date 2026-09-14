import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { SessionGuard, type AuthenticatedRequest } from '../identity/session.guard.js';
import { WorkflowService } from './workflow.service.js';

@Controller()
@UseGuards(SessionGuard)
export class WorkflowController {
  constructor(@Inject(WorkflowService) private readonly workflows: WorkflowService) {}

  @Get('workflows')
  list(@Req() request: AuthenticatedRequest) {
    return this.workflows.list(request.userId);
  }

  @Post('workflows')
  create(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.workflows.create(request.userId, body);
  }

  @Get('workflows/:id')
  detail(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.workflows.detail(request.userId, id);
  }

  @Put('workflows/:id')
  update(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.workflows.update(request.userId, id, body);
  }

  @Post('workflows/:id/copy')
  copy(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.workflows.copy(request.userId, id);
  }

  @Delete('workflows/:id')
  archive(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.workflows.archive(request.userId, id);
  }
}
