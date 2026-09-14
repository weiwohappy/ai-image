import { Body, Controller, Headers, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { SessionGuard, type AuthenticatedRequest } from '../identity/session.guard.js';
import { ToolExecutionService } from './tool-execution.service.js';
@Controller()
@UseGuards(SessionGuard)
export class ToolExecutionController {
  constructor(@Inject(ToolExecutionService) private readonly tools: ToolExecutionService) {}
  @Post('tool-run-quotes')
  quote(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.tools.quote(request.userId, body);
  }
  @Post('tool-runs')
  run(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string,
  ) {
    return this.tools.run(request.userId, body, key ?? '');
  }
}
