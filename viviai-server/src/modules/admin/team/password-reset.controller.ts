import { Body, Controller, Inject, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { parse } from '../auth.controller.js';
import { emailSchema } from './policy.js';
import { AdminPasswordResetService } from './password-reset.service.js';
@Controller('admin/auth/password-resets')
export class AdminPasswordResetController {
  constructor(@Inject(AdminPasswordResetService) readonly resets: AdminPasswordResetService) {}
  @Post('accept') accept(@Req() r: Request, @Body() body: unknown) {
    return this.resets.accept(
      parse(
        z
          .object({
            token: z.string().regex(/^[\w-]{43}$/),
            email: emailSchema,
            password: z.string().min(1).max(128),
          })
          .strict(),
        body,
      ),
      r.socket.remoteAddress ?? 'unknown',
    );
  }
}
