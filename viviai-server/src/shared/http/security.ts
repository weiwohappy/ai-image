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
  app.useBodyParser('urlencoded', { extended: true, limit: config.formBodyLimit });
  app.use((request: Request, response: Response, next: NextFunction) => {
    const requestId = getRequestId(request);
    response.setHeader('X-Request-Id', requestId);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && (!request.headers.origin || !config.corsOrigins.includes(request.headers.origin))) {
      response.status(403).json({ data: null, message: 'Request origin is not allowed', code: 'CSRF_ORIGIN', requestId });
      return;
    }
    next();
  });
  app.enableCors({
    credentials: true,
    origin(origin, callback) {
      if (!origin || config.corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
  });
}
