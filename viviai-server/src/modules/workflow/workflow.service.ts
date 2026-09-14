import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService } from '../../shared/database/database.service.js';
import { AppError } from '../../shared/http/errors.js';
import { parseWorkflowDefinition, parseWorkflowUpdate } from './workflow-contracts.js';
import { presentWorkflow, readStoredContent, type WorkflowDto } from './workflow-presenter.js';

const workflowIdSchema = z.uuid();
const rowsInclude = { rows: { orderBy: { sortOrder: 'asc' as const } } };

@Injectable()
export class WorkflowService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  async create(userId: string, raw: unknown): Promise<WorkflowDto> {
    const definition = parseWorkflowDefinition(raw);
    const workflow = await this.db.client.workflow.create({
      data: {
        userId,
        name: definition.name,
        columns: definition.columns,
        rows: { create: definition.rows.map((row, index) => ({ ...row, sortOrder: index })) },
      },
      include: rowsInclude,
    });
    return presentWorkflow(workflow);
  }

  async list(userId: string): Promise<WorkflowDto[]> {
    const workflows = await this.db.client.workflow.findMany({
      where: { userId, archivedAt: null },
      orderBy: { updatedAt: 'desc' },
      include: rowsInclude,
    });
    return workflows.map(presentWorkflow);
  }

  async detail(userId: string, rawId: string): Promise<WorkflowDto> {
    const id = parseId(rawId);
    const workflow = await this.db.client.workflow.findFirst({
      where: { id, userId, archivedAt: null },
      include: rowsInclude,
    });
    if (!workflow) throw notFound();
    return presentWorkflow(workflow);
  }

  async update(userId: string, rawId: string, raw: unknown): Promise<WorkflowDto> {
    const id = parseId(rawId);
    const input = parseWorkflowUpdate(raw);
    return this.db.transaction(async (tx) => {
      const existing = await tx.workflow.findFirst({
        where: { id, userId, archivedAt: null },
        select: { id: true },
      });
      if (!existing) throw notFound();
      const updated = await tx.workflow.updateMany({
        where: { id, userId, version: input.version },
        data: { name: input.name, columns: input.columns, version: { increment: 1 } },
      });
      if (updated.count === 0) throw versionConflict();
      await tx.workflowRow.deleteMany({ where: { workflowId: id } });
      await tx.workflowRow.createMany({
        data: input.rows.map((row, index) => ({ workflowId: id, ...row, sortOrder: index })),
      });
      const workflow = await tx.workflow.findUniqueOrThrow({ where: { id }, include: rowsInclude });
      return presentWorkflow(workflow);
    });
  }

  async copy(userId: string, rawId: string): Promise<WorkflowDto> {
    const id = parseId(rawId);
    const source = await this.db.client.workflow.findFirst({
      where: { id, userId, archivedAt: null },
      include: rowsInclude,
    });
    if (!source) throw notFound();
    const content = readStoredContent(source);
    const copy = await this.db.client.workflow.create({
      data: {
        userId,
        name: `${source.name} (副本)`,
        columns: content.columns,
        rows: {
          create: content.rows.map((row, index) => ({
            rowKey: row.rowKey,
            sortOrder: index,
            cells: row.cells,
          })),
        },
      },
      include: rowsInclude,
    });
    return presentWorkflow(copy);
  }

  async archive(userId: string, rawId: string): Promise<{ id: string }> {
    const id = parseId(rawId);
    const result = await this.db.client.workflow.updateMany({
      where: { id, userId, archivedAt: null },
      data: { archivedAt: new Date() },
    });
    if (result.count === 0) throw notFound();
    return { id };
  }
}

function parseId(rawId: string): string {
  const parsed = workflowIdSchema.safeParse(rawId);
  if (!parsed.success) throw notFound();
  return parsed.data;
}

function notFound(): AppError {
  return new AppError(404, 'WORKFLOW_NOT_FOUND', 'Workflow not found');
}

function versionConflict(): AppError {
  return new AppError(409, 'WORKFLOW_VERSION_CONFLICT', 'Workflow was modified by another change');
}
