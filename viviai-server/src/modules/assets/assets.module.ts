import { Module } from '@nestjs/common';
import type { AppConfig } from '../../config.js';
import { APP_CONFIG } from '../../shared/infrastructure.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { AssetService, ASSET_STORE } from './assets.service.js';
import { AssetsController } from './assets.controller.js';
import { LocalObjectStore } from './local-object-store.js';
import { S3ObjectStore } from './s3-object-store.js';
@Module({ imports: [IdentityModule], controllers: [AssetsController], providers: [AssetService, {
  provide: ASSET_STORE, inject: [APP_CONFIG], useFactory: (config: AppConfig) => config.storageDriver === 'local'
    ? new LocalObjectStore(config.localStorageRoot)
    : new S3ObjectStore({ bucket: config.s3Bucket!, region: config.s3Region!, forcePathStyle: config.s3ForcePathStyle,
      ...(config.s3Endpoint === undefined ? {} : { endpoint: config.s3Endpoint }),
      ...(config.s3AccessKeyId === undefined ? {} : { accessKeyId: config.s3AccessKeyId }),
      ...(config.s3SecretAccessKey === undefined ? {} : { secretAccessKey: config.s3SecretAccessKey }) }),
}], exports: [AssetService, ASSET_STORE] })
export class AssetsModule {}
