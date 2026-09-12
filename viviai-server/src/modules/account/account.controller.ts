import { Body, Controller, Inject, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { parseInput } from '../identity/identity.controller.js';
import { sessionToken, SessionGuard, type AuthenticatedRequest } from '../identity/session.guard.js';
import { sessionTokenHash } from '../identity/identity.service.js';
import { AccountService } from './account.service.js';

const username = z.string().trim().toLowerCase().regex(/^[a-z0-9_]{3,32}$/);
const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(12).max(128);
const code = z.string().regex(/^\d{6}$/);

@Controller('account')
@UseGuards(SessionGuard)
export class AccountController {
  constructor(@Inject(AccountService) private readonly account: AccountService) {}

  @Patch('profile')
  updateProfile(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.account.updateProfile(
      req.userId,
      parseInput(z.object({ username }).strict(), body),
    );
  }

  @Post('change-email')
  changeEmail(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.account.changeEmail(
      req.userId,
      sessionTokenHash(sessionToken(req)),
      parseInput(z.object({ email, code }).strict(), body),
    );
  }

  @Post('change-password')
  changePassword(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.account.changePassword(
      req.user,
      sessionTokenHash(sessionToken(req)),
      parseInput(z.object({ password, code }).strict(), body),
    );
  }
}
