import type { INestApplication } from '@nestjs/common';
import { createApp } from '../../src/main.js';

export function createTestApp(databaseUrl: string): Promise<INestApplication> {
  return createApp({
    nodeEnv: 'test',
    databaseUrl,
    storageDriver: 'local',
    simulationProviderEnabled: true,
    devMailEnabled: true,
  });
}
