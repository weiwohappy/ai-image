import { Body, Controller, Get, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AppError } from '../../shared/http/errors.js';
import { ADMIN_COOKIE, CHALLENGE_COOKIE, AdminAuthService } from './auth.service.js';
import { AdminSessionGuard, cookie, type AdminRequest } from './session.guard.js';
import { localTestPasswordsEnabled, localPasswordLoginEnabled } from './config.js';
import { teamWritesEnabled } from './team/policy.js';
export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw new AppError(400, 'ADMIN_INVALID_INPUT', 'Invalid administrator request');
  return parsed.data;
}
const email = z
  .string()
  .trim()
  .email()
  .max(254)
  .transform((s) => s.toLowerCase());
// The service enforces 12 characters, except for explicit loopback development accounts.
const password = z.string().min(1).max(128);
@Controller('admin')
export class AdminAuthController {
  constructor(@Inject(AdminAuthService) private readonly auth: AdminAuthService) {}
  private setCookie(response: Response, name: string, value: string, seconds: number) {
    response.cookie(name, value, {
      httpOnly: true,
      sameSite: 'strict',
      secure: this.auth.config.nodeEnv === 'production',
      path: '/api/admin',
      maxAge: seconds * 1000,
    });
    response.setHeader('Cache-Control', 'no-store');
  }
  @Get('status') status(@Req() request: Request) {
    return {
      enabled: this.auth.config.admin?.enabled ?? false,
      environment: this.auth.config.nodeEnv,
      stage: 'B1',
      teamWritesEnabled: teamWritesEnabled(
        this.auth.config,
        request.socket.remoteAddress ?? 'unknown',
      ),
      ...(localTestPasswordsEnabled(this.auth.config) ? { localTestPasswords: true } : {}),
      ...(localPasswordLoginEnabled(this.auth.config) ? { localPasswordLogin: true } : {}),
    };
  }
  @Get('me') @UseGuards(AdminSessionGuard) me(@Req() request: AdminRequest) {
    return request.admin.actor;
  }
  @Post('auth/login') async login(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.auth.enabled();
    const data = parse(z.object({ email, password }).strict(), body);
    const result = await this.auth.login(data.email, data.password, request.ip ?? 'unknown');
    if ('account' in result.data) {
      this.setCookie(response, ADMIN_COOKIE, result.raw, 8 * 3600);
      this.setCookie(response, CHALLENGE_COOKIE, '', 0);
    } else this.setCookie(response, CHALLENGE_COOKIE, result.raw, 600);
    return result.data;
  }
  @Post('auth/invitations/accept') async accept(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.auth.enabled();
    const data = parse(
      z
        .object({
          email,
          password,
          token: z.string().regex(/^[\w-]{43}$/),
          displayName: z.string().trim().min(1).max(80),
        })
        .strict(),
      body,
    );
    const result = await this.auth.accept(data, request.ip ?? 'unknown');
    if ('account' in result.data) {
      this.setCookie(response, ADMIN_COOKIE, result.raw, 8 * 3600);
      this.setCookie(response, CHALLENGE_COOKIE, '', 0);
    } else this.setCookie(response, CHALLENGE_COOKIE, result.raw, 600);
    return result.data;
  }
  @Post('auth/mfa/verify') async verify(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.auth.enabled();
    const data = parse(
      z.object({ method: z.enum(['totp', 'recovery']), code: z.string().min(1).max(128) }).strict(),
      body,
    );
    const result = await this.auth.verify(
      cookie(request, CHALLENGE_COOKIE),
      data.method,
      data.code,
      request.ip ?? 'unknown',
    );
    this.setCookie(response, ADMIN_COOKIE, result.raw, 8 * 3600);
    this.setCookie(response, CHALLENGE_COOKIE, '', 0);
    return result.data;
  }
  @Post('auth/logout') async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.auth.logout(
      cookie(request, ADMIN_COOKIE),
      cookie(request, CHALLENGE_COOKIE),
    );
    this.setCookie(response, ADMIN_COOKIE, '', 0);
    this.setCookie(response, CHALLENGE_COOKIE, '', 0);
    return result;
  }
}
