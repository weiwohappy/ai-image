import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { AdminSessionGuard, type AdminRequest } from './session.guard.js';
import { AdminSensitiveService } from './sensitive.service.js';
import { parse } from './auth.controller.js';
import { id } from './query.service.js';
const reason = z
  .string()
  .trim()
  .min(10)
  .max(500)
  .refine(
    (s) =>
      !/(?:bearer\s+|sk-[A-Za-z0-9_-]{8,}|AIza[\w-]{15,}|-----BEGIN|(?:password|passwd|secret|token|api[_ -]?key)\s*[:=]|\beyJ[\w-]+\.[\w-]+\.[\w-]+|[\w+/=-]{40,})/i.test(
        s,
      ),
  );
@Controller('admin')
@UseGuards(AdminSessionGuard)
export class AdminSensitiveController {
  constructor(@Inject(AdminSensitiveService) private readonly sensitive: AdminSensitiveService) {}
  @Post('sensitive-access-grants') grant(@Req() r: AdminRequest, @Body() body: unknown) {
    const data = parse(z.object({ jobId: z.uuid(), reason }).strict(), body);
    return this.sensitive.grant(r.admin, data.jobId, data.reason);
  }
  @Get('jobs/:id/sensitive') async content(
    @Req() r: AdminRequest,
    @Param('id') jobId: string,
    @Query() raw: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { grantId } = parse(z.object({ grantId: z.uuid() }).strict(), raw);
    response.setHeader('Cache-Control', 'no-store');
    return this.sensitive.content(r.admin, id(jobId), grantId);
  }
  @Get('assets/:id/preview') async preview(
    @Req() r: AdminRequest,
    @Param('id') assetId: string,
    @Query() raw: unknown,
    @Res() response: Response,
  ) {
    const { grantId } = parse(z.object({ grantId: z.uuid() }).strict(), raw);
    const result = await this.sensitive.preview(r.admin, id(assetId), grantId);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', result.contentType);
    response.send(Buffer.from(result.bytes));
  }
}
