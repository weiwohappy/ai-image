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
import { SessionGuard, type AuthenticatedRequest } from '../identity/session.guard.js';
import { WalletService } from '../wallet/wallet.service.js';
import { GenerationService } from './generation.service.js';
@Controller()
@UseGuards(SessionGuard)
export class GenerationController {
  constructor(
    @Inject(GenerationService) private readonly jobs: GenerationService,
    @Inject(WalletService) private readonly wallet: WalletService,
  ) {}
  @Post('generation-tasks') create(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string,
  ) {
    return this.jobs.create(req.userId, body, key ?? '', 'create');
  }
  @Post('remix-tasks') remix(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string,
  ) {
    return this.jobs.create(req.userId, body, key ?? '', 'remix');
  }
  @Get('generation-tasks') list(@Req() req: AuthenticatedRequest) {
    return this.jobs.list(req.userId);
  }
  @Get('generation-tasks/:id') get(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.jobs.get(req.userId, id);
  }
  @Post('generation-tasks/:id/cancel') cancel(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    return this.jobs.cancel(req.userId, id);
  }
  @Post('generation-tasks/:id/retry') retry(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string,
  ) {
    return this.jobs.retry(req.userId, id, body, key ?? '');
  }
  @Get('point-ledger') ledger(@Req() req: AuthenticatedRequest) {
    return this.wallet.ledger(req.userId);
  }
}
