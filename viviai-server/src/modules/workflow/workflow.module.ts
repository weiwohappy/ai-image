import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { WorkflowController } from './workflow.controller.js';
import { WorkflowQuoteService } from './workflow-quote.service.js';
import { WorkflowService } from './workflow.service.js';

@Module({
  imports: [IdentityModule, CatalogModule],
  controllers: [WorkflowController],
  providers: [WorkflowService, WorkflowQuoteService],
  exports: [WorkflowService, WorkflowQuoteService],
})
export class WorkflowModule {}
