import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { CatalogController } from './catalog.controller.js';
import { CatalogService } from './catalog.service.js';
@Module({ imports: [IdentityModule], controllers: [CatalogController], providers: [CatalogService], exports: [CatalogService] })
export class CatalogModule {}
