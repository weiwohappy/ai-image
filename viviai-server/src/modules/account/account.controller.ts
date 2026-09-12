import { Body, Controller, Inject, Patch, Post, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import { parseInput } from '../identity/identity.controller.js';
import { sessionToken, SessionGuard, type AuthenticatedRequest } from '../identity/session.guard.js';
import { sessionTokenHash } from '../identity/identity.service.js';
import { AccountService } from './account.service.js';
import { AppError } from '../../shared/http/errors.js';
import { AVATAR_MAX_IMAGE_BYTES } from '../assets/assets.service.js';

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

  @Post('avatar')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: AVATAR_MAX_IMAGE_BYTES, files: 1, fields: 0 },
    }),
  )
  uploadAvatar(
    @Req() req: AuthenticatedRequest,
    @UploadedFile() file?: { buffer: Buffer; originalname: string },
  ) {
    if (!file) throw new AppError(400, 'ASSET_INVALID', 'An avatar image is required');
    return this.account.uploadAvatar(req.userId, file.buffer, file.originalname);
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
