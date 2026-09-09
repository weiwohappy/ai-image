import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response, NextFunction } from 'express';
import type { AppConfig } from '../../config.js';

type RequestWithId = Request & { requestId?: string };

export function getRequestId(request: Request): string {
  const value = (request as RequestWithId).requestId;
  if (value) return value;
  const generated = randomUUID();
  (request as RequestWithId).requestId = generated;
  return generated;
}

export function configureHttpSecurity(app: NestExpressApplication, config: AppConfig): void {
  app.useBodyParser('json', { limit: config.jsonBodyLimit });
  app.useBodyParser('urlencoded', { extended: false, limit: config.formBodyLimit });
  app.use((request: Request, response: Response, next: NextFunction) => {
    const requestId = getRequestId(request);
    // Express routes are case-insensitive; the security boundary must match them.
    const isAdminRoute = /^\/api\/admin(?:\/|$)/i.test(request.path);
    response.setHeader('X-Request-Id', requestId);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    if (isAdminRoute) response.setHeader('Cache-Control', 'no-store');
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      !(
        request.method === 'POST' &&
        ['/api/webhooks/payments/wechat', '/api/webhooks/payments/alipay'].includes(request.path)
      ) &&
      (!request.headers.origin ||
        !(isAdminRoute ? (config.admin?.origins ?? []) : config.corsOrigins).includes(
          request.headers.origin,
        ))
    ) {
      response.status(403).json({
        data: null,
        message: 'Request origin is not allowed',
        code: 'CSRF_ORIGIN',
        requestId,
      });
      return;
    }
    next();
  });
  app.enableCors({
    credentials: true,
    origin(origin, callback) {
      if (!origin || [...config.corsOrigins, ...(config.admin?.origins ?? [])].includes(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
  });
}
