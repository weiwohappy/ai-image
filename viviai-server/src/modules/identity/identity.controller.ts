import { Body, Controller, Get, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { AppConfig } from '../../config.js';
import { APP_CONFIG } from '../../shared/infrastructure.module.js';
import { AppError } from '../../shared/http/errors.js';
import { IdentityService, accountDto, SESSION_COOKIE, SESSION_MAX_AGE_MS, type PublicAccount } from './identity.service.js';
import { SessionGuard, sessionToken, type AuthenticatedRequest } from './session.guard.js';
import { WalletService } from '../wallet/wallet.service.js';
import { safeInteger } from '../../shared/database/locks.js';
const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(12).max(128);
const code = z.string().regex(/^\d{6}$/);
export function parseInput<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new AppError(400, 'INVALID_INPUT', 'Request fields are invalid');
  return parsed.data;
}
@Controller()
export class IdentityController {
  constructor(@Inject(IdentityService) private readonly identity: IdentityService, @Inject(APP_CONFIG) private readonly config: AppConfig, @Inject(WalletService) private readonly wallet: WalletService) {}
  private async authenticated(user: PublicAccount, response: Response) {
    response.cookie(SESSION_COOKIE, await this.identity.createSession(user.id), { httpOnly: true, sameSite: 'lax', secure: this.config.nodeEnv === 'production', path: '/', maxAge: SESSION_MAX_AGE_MS });
    return this.publicAccount(user);
  }
  @Post('auth/send-code')
  async sendCode(@Body() body: unknown, @Req() req: Request) {
    const input = parseInput(z.object({ email, purpose: z.enum(['register', 'reset-password']).default('register') }), body);
    await this.identity.rateLimit('send-code', input.email, req.ip ?? 'unknown');
    return this.identity.sendCode(input.email, input.purpose);
  }
  @Post('auth/register')
  async register(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) response: Response) {
    const input = parseInput(z.object({ email, password, code, username: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{3,32}$/) }), body);
    await this.identity.rateLimit('register', input.email, req.ip ?? 'unknown');
    return this.authenticated(await this.identity.register(input), response);
  }
  @Post('auth/login')
  async login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) response: Response) {
    const input = parseInput(z.object({ account: z.string().trim().toLowerCase().min(1).max(254), password: z.string().min(1).max(128) }), body);
    await this.identity.rateLimit('login', input.account, req.ip ?? 'unknown');
    return this.authenticated(await this.identity.login(input.account, input.password), response);
  }
  @Post('auth/reset-password')
  async reset(@Body() body: unknown, @Req() req: Request) {
    const input = parseInput(z.object({ email, password, code }), body);
    await this.identity.rateLimit('reset-password', input.email, req.ip ?? 'unknown');
    return this.identity.resetPassword(input.email, input.code, input.password);
  }
  @Post('auth/logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) response: Response) {
    await this.identity.logout(sessionToken(req));
    response.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure: this.config.nodeEnv === 'production', path: '/' });
    return { success: true };
  }
  @UseGuards(SessionGuard)
  @Get('me')
  me(@Req() req: AuthenticatedRequest) { return this.publicAccount(req.user); }
  private async publicAccount(user: PublicAccount) {
    const balance = await this.wallet.balance(user.id);
    return { ...accountDto(user), credits: safeInteger(balance.available), frozenCredits: safeInteger(balance.held) };
  }
}
