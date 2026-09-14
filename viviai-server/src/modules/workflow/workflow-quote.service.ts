import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService, type DbTransaction } from '../../shared/database/database.service.js';
import { AppError } from '../../shared/http/errors.js';
import { CatalogService } from '../catalog/catalog.service.js';
import { digest, PRODUCT_ID } from '../catalog/input-schema.js';
import type { ToolDefinitionRow } from '../tool-execution/tool-compiler.js';
import { RUN_TERMINAL, isRetryable } from './batch-projection.service.js';
import {
  compileWorkflowSelection,
  type CompiledWorkflowItem,
  type WorkflowItemIssue,
} from './workflow-compiler.js';
import { readRunSnapshot, readStoredContent } from './workflow-presenter.js';

const selectionSchema = z
  .object({
    workflowId: z.uuid(),
    rowIds: z.array(z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/)).min(1).max(200),
  })
  .strict();

const retrySchema = z.object({ retryRunId: z.uuid() }).strict();

interface QuotedItem extends CompiledWorkflowItem {
  quoteId: string;
  inputHash: string;
  unitCredits: number;
  totalCredits: number;
  createdAt: string;
  expiresAt: string;
}

@Injectable()
export class WorkflowQuoteService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(CatalogService) private readonly catalog: CatalogService,
  ) {}

  /**
   * Prices every selected row and output column. Unusable items are reported
   * per row/column and no quotes are written unless the whole selection is
   * executable, so a batch is either fully quotable or fully rejected.
   */
  async quote(userId: string, raw: unknown) {
    const retry = retrySchema.safeParse(raw);
    if (retry.success)
      return this.db.transaction((tx) => this.quoteRetryIn(tx, userId, retry.data.retryRunId));

    const parsed = selectionSchema.safeParse(raw);
    if (!parsed.success)
      throw new AppError(400, 'INVALID_INPUT', 'A workflow and selected rows are required');
    const { workflowId, rowIds } = parsed.data;

    const workflow = await this.db.client.workflow.findFirst({
      where: { id: workflowId, userId, archivedAt: null },
      include: { rows: { orderBy: { sortOrder: 'asc' } } },
    });
    if (!workflow) throw new AppError(404, 'WORKFLOW_NOT_FOUND', 'Workflow not found');

    const content = readStoredContent(workflow);
    const tools = await this.loadTools(content.columns);
    const { items, issues } = compileWorkflowSelection(
      { id: workflow.id, version: workflow.version, columns: content.columns, rows: content.rows },
      rowIds,
      tools,
    );

    const usable: CompiledWorkflowItem[] = [];
    for (const item of items) {
      const issue = await this.preflight(userId, item);
      if (issue) issues.push(issue);
      else usable.push(item);
    }

    if (issues.length) return this.rejected(workflow.id, workflow.version, issues);
    return this.db.transaction((tx) =>
      this.recordIn(tx, userId, workflow.id, workflow.version, usable),
    );
  }

  /**
   * Prices only the failed, retryable columns of a settled batch, on the caller's
   * transaction: an operator retry records its quote and starts the run together,
   * so an abandoned retry never leaves a priced quote behind. The run's own
   * workflow snapshot is used so a retry reproduces the quoted version, and a
   * completed run with nothing left to retry yields an empty, unsubmittable quote.
   */
  async quoteRetryIn(tx: DbTransaction, userId: string, runId: string) {
    const run = await tx.workflowRun.findFirst({
      where: { id: runId, userId },
      include: { items: true },
    });
    if (!run) throw new AppError(404, 'RUN_NOT_FOUND', 'Batch run not found');
    if (!RUN_TERMINAL.includes(run.status))
      throw new AppError(409, 'RUN_NOT_SETTLED', 'This batch is still running');
    const snapshot = readRunSnapshot(run.workflowSnapshot);

    const targets = run.items.filter(
      (item) => item.status === 'failed' && isRetryable(item.errorCode),
    );
    if (!targets.length) return this.rejected(snapshot.workflowId, snapshot.workflowVersion, []);

    const tools = await this.loadTools(snapshot.columns);
    const { items, issues } = compileWorkflowSelection(
      {
        id: snapshot.workflowId,
        version: snapshot.workflowVersion,
        columns: snapshot.columns,
        rows: snapshot.rows,
      },
      [...new Set(targets.map((item) => item.rowKey))],
      tools,
      targets.map((item) => item.columnKey),
    );

    const usable: CompiledWorkflowItem[] = [];
    for (const item of items) {
      const issue = await this.preflight(userId, item);
      if (issue) issues.push(issue);
      else usable.push(item);
    }
    // Rows can share column keys, so keep only the row/column pairs that failed.
    const wanted = new Set(targets.map((item) => `${item.rowKey}:${item.columnKey}`));
    const selected = usable.filter((item) => wanted.has(`${item.rowKey}:${item.columnId}`));
    const missing = targets.filter(
      (item) =>
        !selected.some(
          (entry) => entry.rowKey === item.rowKey && entry.columnId === item.columnKey,
        ),
    );
    for (const item of missing)
      if (!issues.some((issue) => issue.rowKey === item.rowKey && issue.columnId === item.columnKey))
        issues.push({
          rowKey: item.rowKey,
          columnId: item.columnKey,
          code: 'RETRY_UNAVAILABLE',
          message: 'This item can no longer be reproduced from the batch snapshot',
        });

    if (issues.length) return this.rejected(snapshot.workflowId, snapshot.workflowVersion, issues);
    return this.recordIn(tx, userId, snapshot.workflowId, snapshot.workflowVersion, selected);
  }

  private async recordIn(
    tx: DbTransaction,
    userId: string,
    workflowId: string,
    workflowVersion: number,
    items: CompiledWorkflowItem[],
  ) {
    const quoted: QuotedItem[] = [];
    for (const item of items) {
      const quote = await this.catalog.createQuoteIn(tx, userId, item.generationInput, {
        type: 'workflow',
        id: workflowId,
        version: workflowVersion,
        snapshot: item.originSnapshot,
      });
      quoted.push({
        ...item,
        quoteId: quote.id,
        inputHash: quote.inputHash,
        unitCredits: quote.unitCredits,
        totalCredits: quote.totalCredits,
        createdAt: quote.createdAt,
        expiresAt: quote.expiresAt,
      });
    }
    const aggregate = await tx.workflowRunQuote.create({
      data: {
        userId,
        workflowId,
        inputHash: digest({
          workflowId,
          workflowVersion,
          items: quoted.map((item) => ({
            rowKey: item.rowKey,
            columnKey: item.columnId,
            inputHash: item.inputHash,
          })),
        }),
        workflowVersion,
        totalCredits: quoted.reduce((sum, item) => sum + BigInt(item.totalCredits), 0n),
        expiresAt: new Date(Math.min(...quoted.map((item) => Date.parse(item.expiresAt)))),
        items: {
          create: quoted.map((item) => ({
            rowKey: item.rowKey,
            columnKey: item.columnId,
            normalizedInput: item.generationInput,
            originSnapshot: item.originSnapshot,
            unitCredits: BigInt(item.unitCredits),
            totalCredits: BigInt(item.totalCredits),
            generationQuoteId: item.quoteId,
          })),
        },
      },
      select: { id: true, totalCredits: true, createdAt: true, expiresAt: true },
    });

    return {
      quoteId: aggregate.id,
      workflowId,
      workflowVersion,
      submittable: true,
      totalCredits: Number(aggregate.totalCredits),
      createdAt: aggregate.createdAt.toISOString(),
      expiresAt: aggregate.expiresAt.toISOString(),
      items: quoted.map(presentQuoted),
    };
  }

  private rejected(workflowId: string, workflowVersion: number, issues: WorkflowItemIssue[]) {
    return {
      quoteId: null,
      workflowId,
      workflowVersion,
      submittable: false,
      totalCredits: 0,
      createdAt: null,
      expiresAt: null,
      items: issues.map((issue) => ({
        rowKey: issue.rowKey,
        columnId: issue.columnId,
        columnName: null,
        status: 'invalid' as const,
        error: { code: issue.code, message: issue.message },
      })),
    };
  }

  /** Read-only capability, price and ownership checks, kept outside the write transaction. */
  private async preflight(
    userId: string,
    item: CompiledWorkflowItem,
  ): Promise<WorkflowItemIssue | undefined> {
    const issue = (code: string, message: string): WorkflowItemIssue => ({
      rowKey: item.rowKey,
      columnId: item.columnId,
      code,
      message,
    });
    try {
      this.catalog.execution(item.generationInput);
    } catch {
      return issue('MODEL_UNAVAILABLE', 'The saved model specification is unavailable');
    }
    if (item.generationInput.modelId !== PRODUCT_ID) {
      const price = await this.db.client.modelCreditPrice.findUnique({
        where: {
          modelId_resolution: {
            modelId: item.generationInput.modelId,
            resolution: item.generationInput.resolution,
          },
        },
        select: { enabled: true },
      });
      if (!price?.enabled) return issue('PRICE_UNAVAILABLE', 'Model pricing is unavailable');
    }
    const assetIds = [
      item.generationInput.referenceAssetId,
      item.generationInput.subjectAssetId,
    ].filter((id): id is string => Boolean(id));
    if (assetIds.length) {
      const owned = await this.db.client.asset.count({
        where: { id: { in: assetIds }, userId, deletedAt: null, status: 'ready' },
      });
      if (owned !== assetIds.length)
        return issue('ASSET_NOT_FOUND', 'A reference image is missing or unavailable');
    }
    return undefined;
  }

  private async loadTools(
    columns: Array<{ type: string; toolId?: string; toolVersion?: number }>,
  ): Promise<ToolDefinitionRow[]> {
    const wanted = columns.filter(
      (column): column is { type: string; toolId: string; toolVersion: number } =>
        column.type === 'tool' && Boolean(column.toolId) && Boolean(column.toolVersion),
    );
    if (!wanted.length) return [];
    return this.db.client.toolDefinition.findMany({
      where: {
        status: 'published',
        OR: wanted.map((column) => ({
          externalId: column.toolId,
          version: column.toolVersion,
        })),
      },
    });
  }
}

function presentQuoted(item: QuotedItem) {
  return {
    rowKey: item.rowKey,
    columnId: item.columnId,
    columnName: item.columnName,
    status: 'ready' as const,
    quoteId: item.quoteId,
    modelId: item.generationInput.modelId,
    resolution: item.generationInput.resolution,
    ratio: item.generationInput.ratio,
    count: item.generationInput.count,
    unitCredits: item.unitCredits,
    totalCredits: item.totalCredits,
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
  };
}
