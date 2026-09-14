import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { GenerationModule } from '../generation/generation.module.js';
import { BatchProjectionService } from './batch-projection.service.js';
import { WorkflowController } from './workflow.controller.js';
import { WorkflowQuoteService } from './workflow-quote.service.js';
import { WorkflowRunService } from './workflow-run.service.js';
import { WorkflowService } from './workflow.service.js';

@Module({
  imports: [IdentityModule, CatalogModule, GenerationModule],
  controllers: [WorkflowController],
  providers: [WorkflowService, WorkflowQuoteService, WorkflowRunService, BatchProjectionService],
  exports: [WorkflowService, WorkflowQuoteService, WorkflowRunService, BatchProjectionService],
})
export class WorkflowModule {}
