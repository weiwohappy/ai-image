import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService, type DbTransaction } from '../../shared/database/database.service.js';
import { lockWallet } from '../../shared/database/locks.js';
import { AppError } from '../../shared/http/errors.js';
import type { WorkflowRunQuote } from '../../generated/prisma/client.js';
import { normalizeInput } from '../catalog/input-schema.js';
import { GenerationService } from '../generation/generation.service.js';
import { jobInclude } from '../generation/job-serializer.js';
import { BatchProjectionService, RUN_TERMINAL, isRetryable } from './batch-projection.service.js';
import {
  readRunSnapshot,
  readStoredContent,
  type WorkflowRunSnapshot,
} from './workflow-presenter.js';

const submitSchema = z.object({ quoteId: z.uuid() }).strict();
const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

const notFound = () => new AppError(404, 'RUN_NOT_FOUND', 'Batch run not found');

/**
 * Executes workflow batches: one aggregate quote becomes one run, every quoted
 * row and column becomes an independent generation job, and the run projects the
 * outcome of those jobs. Cancellation and retry never reuse a consumed quote.
 */
@Injectable()
export class WorkflowRunService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(GenerationService) private readonly generation: GenerationService,
    @Inject(BatchProjectionService) private readonly projection: BatchProjectionService,
  ) {}

  async submit(userId: string, raw: unknown, key: string) {
    const parsed = submitSchema.safeParse(raw);
    if (!parsed.success || !KEY_PATTERN.test(key))
      throw new AppError(400, 'INVALID_INPUT', 'A batch quote and valid Idempotency-Key are required');
    return this.db.transaction(async (tx) => {
      await lockWallet(tx, userId);
      const quote = await this.aggregate(tx, userId, parsed.data.quoteId);
      const replay = await this.replay(tx, userId, key);
      if (replay) {
        if (replay.workflowId !== quote.workflowId)
          throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'Key was used for a different request');
        return this.present(tx, userId, replay.id);
      }
      this.assertConsumable(quote);
      const workflow = quote.workflowId
        ? await tx.workflow.findFirst({
            where: { id: quote.workflowId, userId, archivedAt: null },
            include: { rows: { orderBy: { sortOrder: 'asc' } } },
          })
        : null;
      if (!workflow) throw new AppError(404, 'WORKFLOW_NOT_FOUND', 'Workflow not found');
      // Outstanding quotes are only valid for the version they were priced from.
      if (workflow.version !== quote.workflowVersion)
        throw new AppError(
          409,
          'WORKFLOW_VERSION_CONFLICT',
          'Workflow changed; request and confirm a new quote',
        );
      const content = readStoredContent(workflow);
      return this.start(tx, userId, {
        quote,
        key,
        workflowId: workflow.id,
        snapshot: {
          workflowId: workflow.id,
          workflowVersion: workflow.version,
          name: workflow.name,
          columns: content.columns,
          rows: content.rows,
        },
      });
    });
  }

  async retry(userId: string, runId: string, raw: unknown, key: string) {
    const parsed = submitSchema.safeParse(raw);
    if (!parsed.success || !KEY_PATTERN.test(key))
      throw new AppError(400, 'INVALID_INPUT', 'A batch quote and valid Idempotency-Key are required');
    return this.db.transaction((tx) => this.retryIn(tx, userId, runId, parsed.data.quoteId, key));
  }

  /**
   * The retry itself, on the caller's transaction: an operator command quotes this
   * retry and then starts it, and both must commit or roll back together.
   */
  async retryIn(
    tx: DbTransaction,
    userId: string,
    runId: string,
    quoteId: string,
    key: string,
  ) {
    await lockWallet(tx, userId);
    const previous = await tx.workflowRun.findFirst({
      where: { id: runId, userId },
      include: { items: true },
    });
    if (!previous) throw notFound();
    const quote = await this.aggregate(tx, userId, quoteId);
    const replay = await this.replay(tx, userId, key);
    if (replay) {
      if (replay.retryOfRunId !== previous.id)
        throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'Key was used for a different request');
      return this.present(tx, userId, replay.id);
    }
    if (!RUN_TERMINAL.includes(previous.status))
      throw new AppError(409, 'RUN_NOT_SETTLED', 'This batch is still running');
    if (quote.workflowId !== previous.workflowId)
      throw new AppError(409, 'ORIGIN_MISMATCH', 'Quote does not belong to this batch');
    this.assertConsumable(quote);

    const targets = previous.items.filter(
      (item) => item.status === 'failed' && isRetryable(item.errorCode),
    );
    if (!targets.length)
      throw new AppError(409, 'NOTHING_TO_RETRY', 'This batch has no retryable failures');
    const items = await tx.workflowRunQuoteItem.findMany({
      where: { quoteId: quote.id },
      orderBy: [{ rowKey: 'asc' }, { columnKey: 'asc' }],
    });
    const wanted = new Set(targets.map((item) => `${item.rowKey}:${item.columnKey}`));
    if (
      items.length !== wanted.size ||
      items.some((item) => !wanted.has(`${item.rowKey}:${item.columnKey}`))
    )
      throw new AppError(
        409,
        'RETRY_MISMATCH',
        'The retry quote does not match the failed items of this batch',
      );

    // The retry reproduces the original snapshot, never the current workflow.
    return this.start(tx, userId, {
      quote,
      key,
      workflowId: previous.workflowId,
      snapshot: readRunSnapshot(previous.workflowSnapshot),
      retryOfRunId: previous.id,
    });
  }

  async cancel(userId: string, runId: string) {
    if (!z.uuid().safeParse(runId).success) throw notFound();
    return this.db.transaction((tx) => this.cancelIn(tx, userId, runId));
  }

  /**
   * Cancels inside the caller's transaction. An operator command already holds one,
   * and the wallet locks it takes must be released with the rest of its work.
   */
  async cancelIn(tx: DbTransaction, userId: string, runId: string) {
    await lockWallet(tx, userId);
    const run = await tx.workflowRun.findFirst({
      where: { id: runId, userId },
      include: { items: { include: { generationJob: { include: jobInclude } } } },
    });
    if (!run) throw notFound();
    if (RUN_TERMINAL.includes(run.status))
      throw new AppError(409, 'RUN_ALREADY_SETTLED', 'This batch has already finished');
    await tx.workflowRun.update({ where: { id: run.id }, data: { cancelRequested: true } });
    for (const item of run.items)
      await this.generation.cancelIn(tx, userId, item.generationJob);
    await this.projection.reconcile(tx, run.id);
    return this.present(tx, userId, run.id);
  }

  async detail(userId: string, runId: string) {
    if (!z.uuid().safeParse(runId).success) throw notFound();
    const dto = await this.projection.detail(this.db.client, userId, runId);
    if (!dto) throw notFound();
    return dto;
  }

  list(userId: string) {
    return this.projection.list(this.db.client, userId);
  }

  /** Creates the run, freezes every child credit and consumes the aggregate quote. */
  private async start(
    tx: DbTransaction,
    userId: string,
    options: {
      quote: AggregateQuote;
      key: string;
      workflowId: string | null;
      snapshot: WorkflowRunSnapshot;
      retryOfRunId?: string;
    },
  ) {
    const { quote, key, snapshot } = options;
    const quoted = await tx.workflowRunQuoteItem.findMany({
      where: { quoteId: quote.id },
      orderBy: [{ rowKey: 'asc' }, { columnKey: 'asc' }],
    });
    const run = await tx.workflowRun.create({
      data: {
        userId,
        workflowId: options.workflowId,
        idempotencyKey: key,
        workflowSnapshot: snapshot,
        totalCount: quoted.length,
        succeededCount: 0,
        failedCount: 0,
        cancelledCount: 0,
        status: 'queued',
        ...(options.retryOfRunId ? { retryOfRunId: options.retryOfRunId } : {}),
      },
    });
    await this.generation.createManyFromQuotes(
      tx,
      userId,
      quoted.map((item, index) => ({
        quoteId: item.generationQuoteId,
        operation: normalizeInput(item.normalizedInput).source,
        idempotencyKey: `run-${run.id}-${index}`,
        runId: run.id,
        rowKey: item.rowKey,
        columnKey: item.columnKey,
      })),
    );
    await tx.workflowRunQuote.update({
      where: { id: quote.id },
      data: { consumedAt: new Date() },
    });
    await this.projection.reconcile(tx, run.id);
    return this.present(tx, userId, run.id);
  }

  private async present(tx: DbTransaction, userId: string, runId: string) {
    const dto = await this.projection.detail(tx, userId, runId);
    if (!dto) throw notFound();
    return dto;
  }

  private async replay(tx: DbTransaction, userId: string, key: string) {
    return tx.workflowRun.findUnique({
      where: { userId_idempotencyKey: { userId, idempotencyKey: key } },
    });
  }

  private async aggregate(tx: DbTransaction, userId: string, quoteId: string) {
    const quote = await tx.workflowRunQuote.findFirst({ where: { id: quoteId, userId } });
    if (!quote) throw new AppError(404, 'QUOTE_NOT_FOUND', 'Batch quote not found');
    return quote;
  }

  private assertConsumable(quote: { consumedAt: Date | null; expiresAt: Date }) {
    if (quote.consumedAt)
      throw new AppError(409, 'QUOTE_USED', 'Batch quote has already been used');
    if (quote.expiresAt.getTime() <= Date.now())
      throw new AppError(409, 'QUOTE_EXPIRED', 'Please request a new quote');
  }
}

type AggregateQuote = WorkflowRunQuote;
