import { Controller, DynamicModule, Get, HttpStatus, Inject, Module } from '@nestjs/common';
import type { AppConfig } from './config.js';
import { DatabaseService } from './shared/database/database.service.js';
import { AppError } from './shared/http/errors.js';

export const APP_CONFIG = Symbol('APP_CONFIG');

@Controller()
class HealthController {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  @Get('health')
  health(): { status: string } {
    return { status: 'ok' };
  }

  @Get('health/ready')
  async ready(): Promise<{ status: string }> {
    try {
      await this.database.client.$queryRaw`SELECT 1`;
      return { status: 'ready' };
    } catch {
      throw new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'DATABASE_UNAVAILABLE', 'Database is unavailable');
    }
  }
}

@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        {
          provide: DatabaseService,
          useFactory: () => new DatabaseService(config.databaseUrl),
        },
      ],
      exports: [APP_CONFIG, DatabaseService],
    };
  }
}
