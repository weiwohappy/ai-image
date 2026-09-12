import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { IdentityService, type PublicAccount } from './identity.service.js';
import { sessionToken } from './session.guard.js';

export type OptionalSessionRequest = Request & {
  user?: PublicAccount;
  userId?: string;
};

@Injectable()
export class OptionalSessionGuard implements CanActivate {
  constructor(@Inject(IdentityService) private readonly identity: IdentityService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<OptionalSessionRequest>();
    const user = await this.identity.resolveSession(sessionToken(request));
    if (user) {
      request.user = user;
      request.userId = user.id;
    }
    return true;
  }
}
