import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { BillingService } from './billing.service.js';
import { SessionGuard, type AuthenticatedRequest } from '../identity/session.guard.js';
@Controller('billing')
export class BillingController {
  constructor(@Inject(BillingService) private readonly billing: BillingService) {}
  @Get('catalog') catalog() {
    return this.billing.catalog();
  }
  @Post('orders')
  @UseGuards(SessionGuard)
  create(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string,
  ) {
    return this.billing.create(req.userId, body, key);
  }
  @Get('orders/:id')
  @UseGuards(SessionGuard)
  get(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.billing.get(req.userId, id);
  }
  @Post('orders/:id/sync')
  @UseGuards(SessionGuard)
  sync(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.billing.sync(req.userId, id);
  }
}
@Controller('webhooks/payments')
export class PaymentWebhookController {
  constructor(@Inject(BillingService) private readonly billing: BillingService) {}
  @Post('wechat')
  wechat(@Req() req: Request & { rawBody?: Buffer }, @Res() res: Response) {
    return this.receive('wechat', req, res);
  }
  @Post('alipay')
  alipay(@Req() req: Request & { rawBody?: Buffer }, @Res() res: Response) {
    return this.receive('alipay', req, res);
  }
  private async receive(
    channel: 'wechat' | 'alipay',
    req: Request & { rawBody?: Buffer },
    res: Response,
  ) {
    try {
      if (!req.rawBody) throw new Error('Missing raw body');
      await this.billing.notify(channel, req.rawBody, req.headers);
      if (channel === 'wechat') res.status(204).end();
      else res.status(200).type('text/plain').send('success');
    } catch {
      // Never acknowledge before durable fulfillment, or log untrusted callback fields.
      if (channel === 'wechat')
        res.status(400).json({ code: 'FAIL', message: 'Notification not accepted' });
      else res.status(400).type('text/plain').send('failure');
    }
  }
}
