import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { AppError } from '../../shared/http/errors.js';
import { IdentityService, SESSION_COOKIE, type PublicAccount } from './identity.service.js';
export type AuthenticatedRequest = Request & { user: PublicAccount; userId: string };
export function sessionToken(request: Request): string {
  return (
    request.headers.cookie
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
      ?.slice(SESSION_COOKIE.length + 1) ?? ''
  );
}
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(IdentityService) private readonly identity: IdentityService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = await this.identity.resolveSession(sessionToken(request));
    if (!user) throw new AppError(401, 'AUTH_REQUIRED', 'Please sign in');
    request.user = user;
    request.userId = user.id;
    return true;
  }
}
