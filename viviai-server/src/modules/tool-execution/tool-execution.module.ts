import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { GenerationModule } from '../generation/generation.module.js';
import { ToolExecutionController } from './tool-execution.controller.js';
import { ToolExecutionService } from './tool-execution.service.js';
@Module({
  imports: [IdentityModule, CatalogModule, GenerationModule],
  controllers: [ToolExecutionController],
  providers: [ToolExecutionService],
})
export class ToolExecutionModule {}
