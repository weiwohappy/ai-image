import { DynamicModule, Global, Module } from '@nestjs/common';
import type { AppConfig } from '../config.js';
import { DatabaseService } from './database/database.service.js';
export const APP_CONFIG = Symbol('APP_CONFIG');
@Global()
@Module({})
export class InfrastructureModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: InfrastructureModule,
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: DatabaseService, useFactory: () => new DatabaseService(config.databaseUrl) },
      ],
      exports: [APP_CONFIG, DatabaseService],
    };
  }
}
