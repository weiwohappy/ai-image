import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { ADMIN_COOKIE, AdminAuthService, type AdminContext } from './auth.service.js';
export type AdminRequest = Request & { admin: AdminContext };
export function cookie(request: Request, name: string) {
  return (
    request.headers.cookie
      ?.split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith(`${name}=`))
      ?.slice(name.length + 1) ?? ''
  );
}
@Injectable()
export class AdminSessionGuard implements CanActivate {
  constructor(@Inject(AdminAuthService) private readonly auth: AdminAuthService) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    request.admin = await this.auth.resolve(cookie(request, ADMIN_COOKIE));
    return true;
  }
}
