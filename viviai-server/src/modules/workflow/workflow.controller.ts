import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SessionGuard, type AuthenticatedRequest } from '../identity/session.guard.js';
import { WorkflowQuoteService } from './workflow-quote.service.js';
import { WorkflowRunService } from './workflow-run.service.js';
import { WorkflowService } from './workflow.service.js';

@Controller()
@UseGuards(SessionGuard)
export class WorkflowController {
  constructor(
    @Inject(WorkflowService) private readonly workflows: WorkflowService,
    @Inject(WorkflowQuoteService) private readonly quotes: WorkflowQuoteService,
    @Inject(WorkflowRunService) private readonly runs: WorkflowRunService,
  ) {}

  @Post('workflow-run-quotes')
  quote(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.quotes.quote(request.userId, body);
  }

  @Post('workflow-runs')
  submit(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string,
  ) {
    return this.runs.submit(request.userId, body, key);
  }

  @Get('workflow-runs')
  listRuns(@Req() request: AuthenticatedRequest) {
    return this.runs.list(request.userId);
  }

  @Get('workflow-runs/:id')
  run(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.runs.detail(request.userId, id);
  }

  @Post('workflow-runs/:id/cancel')
  cancelRun(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.runs.cancel(request.userId, id);
  }

  @Post('workflow-runs/:id/retry-failed')
  retryRun(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string,
  ) {
    return this.runs.retry(request.userId, id, body, key);
  }

  @Get('batches')
  batches(@Req() request: AuthenticatedRequest) {
    return this.runs.list(request.userId);
  }

  @Get('batches/:id')
  batch(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.runs.detail(request.userId, id);
  }

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
