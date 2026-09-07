import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { pathToFileURL } from 'node:url';
import { AppModule } from './app.module.js';
import { loadConfig, validateConfig, type AppConfig } from './config.js';
import { EnvelopeInterceptor } from './shared/http/envelope.js';
import { GlobalExceptionFilter } from './shared/http/errors.js';
import { configureHttpSecurity } from './shared/http/security.js';
import { getRequestId } from './shared/http/security.js';
import type { Request, Response } from 'express';

export async function createApp(configOverrides: Partial<AppConfig> = {}): Promise<INestApplication> {
  const config = validateConfig({ ...loadConfig(), ...configOverrides });
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config), {
    bodyParser: false,
    logger: false,
  });
  app.setGlobalPrefix('api');
  configureHttpSecurity(app, config);
  app.useGlobalInterceptors(new EnvelopeInterceptor());
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.enableShutdownHooks();
  await app.init();
  // Adapter fallback is installed after Nest routes so unknown APIs never emit HTML.
  app.use((request: Request, response: Response) => {
    response.status(404).json({ data: null, message: 'Not found', code: 'NOT_FOUND', requestId: getRequestId(request) });
  });
  return app;
}

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await createApp(config);
  await app.listen(config.port, config.host);
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void bootstrap();
}
