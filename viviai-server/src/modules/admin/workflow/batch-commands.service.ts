import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Prisma } from '../../../generated/prisma/client.js';
import type { AppConfig } from '../../../config.js';
import { DatabaseService, type DbTransaction } from '../../../shared/database/database.service.js';
import { AppError } from '../../../shared/http/errors.js';
import { APP_CONFIG } from '../../../shared/infrastructure.module.js';
import {
  RUN_TERMINAL,
  presentRun,
  type RunDto,
} from '../../workflow/batch-projection.service.js';
import { WorkflowQuoteService } from '../../workflow/workflow-quote.service.js';
import { WorkflowRunService } from '../../workflow/workflow-run.service.js';
import { AdminAuditService, type AuditMetadata } from '../audit.service.js';
import { AdminAuthService, lockAdmin, type AdminContext } from '../auth.service.js';
import { adminCommandReceiptLockKey } from '../command-receipt.js';
import { digest } from '../crypto.js';
import { requirePermission } from '../permissions.js';
import { failure, teamWritesEnabled } from '../team/policy.js';

const reasonSchema = z.string().trim().min(5).max(500);
const commandSchema = z.object({ reason: reasonSchema }).strict();

/**
 * The settled facts an operator gets back and that an idempotent replay repeats.
 * It never carries items, task links or asset references, so a receipt cannot
 * become a second, unredacted copy of the batch.
 */
interface BatchResult {
  resourceId: string;
  id: string;
  workflowId: string | null;
  workflowName: string;
  status: string;
  totalCount: number;
  succeededCount: number;
  failedCount: number;
  cancelledCount: number;
  estimatedCredits: number;
  chargedCredits: number;
  cancelRequested: boolean;
  retryOfRunId: string | null;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw failure(400, 'ADMIN_INVALID_INPUT', 'Invalid administrator request');
  return result.data;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonical(nested)]),
    );
  return value;
}

function requestDigest(action: string, target: string, input: Record<string, unknown>): string {
  return digest(JSON.stringify(canonical({ action, target, input })));
}

async function lockBatch(tx: DbTransaction, key: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

/** A malformed batch identifier is indistinguishable from an absent batch. */
function batchId(value: string): string {
  if (!z.uuid().safeParse(value).success) throw failure(404, 'BATCH_NOT_FOUND', '批次不存在');
  return value;
}

function summary(dto: RunDto): BatchResult {
  return {
    resourceId: dto.id,
    id: dto.id,
    workflowId: dto.workflowId,
    workflowName: dto.workflowName,
    status: dto.status,
    totalCount: dto.totalCount,
    succeededCount: dto.succeededCount,
    failedCount: dto.failedCount,
    cancelledCount: dto.cancelledCount,
    estimatedCredits: dto.estimatedCredits,
    chargedCredits: dto.chargedCredits,
    cancelRequested: dto.cancelRequested,
    retryOfRunId: dto.retryOfRunId,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
  };
}

/**
 * Operator disposal of a customer batch. Both commands reuse the customer-facing
 * workflow services inside the administrator's own transaction, so an operator can
 * never cancel or retry a batch in a way the customer-facing rules would refuse —
 * and a commanded change is never committed without its audit record.
 */
@Injectable()
export class AdminBatchCommands {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AdminAuthService) private readonly auth: AdminAuthService,
    @Inject(AdminAuditService) private readonly audit: AdminAuditService,
    @Inject(WorkflowRunService) private readonly runs: WorkflowRunService,
    @Inject(WorkflowQuoteService) private readonly quotes: WorkflowQuoteService,
  ) {}

  cancel(context: AdminContext, key: string, id: string, raw: unknown) {
    const runId = batchId(id);
    const input = parse(commandSchema, raw);
    return this.run(
      context,
      key,
      'batches.cancel',
      runId,
      input,
      ['batches.read', 'batches.manage'],
      async (tx) => {
        await lockBatch(tx, `workflow:batch:${runId}`);
        const { ownerId, batch } = await this.load(tx, runId);
        if (batch.status !== 'queued')
          throw failure(409, 'BATCH_NOT_QUEUED', '批次已开始或已结束，无法取消');
        const cancelled = await this.runs.cancelIn(tx, ownerId, runId);
        return {
          result: summary(cancelled),
          metadata: {
            beforeStatus: batch.status,
            afterStatus: cancelled.status,
            itemCount: cancelled.cancelledCount,
          },
        };
      },
    );
  }

  retryFailed(context: AdminContext, key: string, id: string, raw: unknown) {
    const runId = batchId(id);
    const input = parse(commandSchema, raw);
    return this.run(
      context,
      key,
      'batches.retry-failed',
      runId,
      input,
      ['batches.read', 'batches.manage'],
      async (tx) => {
        await lockBatch(tx, `workflow:batch:${runId}`);
        const { ownerId, batch } = await this.load(tx, runId);
        if (!RUN_TERMINAL.includes(batch.status))
          throw failure(409, 'BATCH_NOT_SETTLED', '批次尚未结束，无法重试');
        if (!batch.items.some((item) => item.status === 'failed' && item.retryable))
          throw failure(409, 'NO_RETRYABLE_FAILURES', '批次没有可重试的失败项');
        // Pricing the retry and consuming its quote belong to this same transaction:
        // a refused or abandoned retry must not leave a priced quote behind.
        const quote = await this.quotes.quoteRetryIn(tx, ownerId, runId);
        if (!quote.submittable || !quote.quoteId)
          throw failure(409, 'NO_RETRYABLE_FAILURES', '批次没有可重试的失败项');
        const retried = await this.runs.retryIn(
          tx,
          ownerId,
          runId,
          quote.quoteId,
          `admin:retry:${context.actor.id}:${key}`,
        );
        return {
          result: {
            ...summary(retried),
            resourceId: runId,
            retryRunId: retried.id,
          },
          metadata: {
            beforeStatus: batch.status,
            afterStatus: retried.status,
            itemCount: retried.totalCount,
          },
        };
      },
    );
  }

  /** Runs one operator command under the administrator's own idempotency receipt. */
  private async run<T extends BatchResult>(
    context: AdminContext,
    key: string,
    action: string,
    target: string,
    input: { reason: string; [key: string]: unknown },
    permissions: string[],
    work: (
      tx: DbTransaction,
      current: AdminContext,
    ) => Promise<{ result: T; metadata?: AuditMetadata }>,
  ): Promise<T> {
    if (!z.uuid().safeParse(key).success)
      throw failure(400, 'ADMIN_INVALID_INPUT', '需要有效幂等键');
    const commandDigest = requestDigest(action, target, input);
    try {
      return await this.db.withSessionAdvisoryLock(
        adminCommandReceiptLockKey(context.actor.id, key),
        30_000,
        () =>
          this.db.transaction(async (tx) => {
            await lockAdmin(tx, context.actor.id);
            const current = await this.auth.reauthorize(
              tx,
              context.sessionId,
              context.actor.id,
              context.requestIp ?? 'unknown',
            );
            if (!teamWritesEnabled(this.config, current.requestIp))
              throw failure(503, 'ADMIN_TEAM_WRITES_DISABLED', '批量任务处置仅在本机开发环境开放');
            for (const permission of permissions) requirePermission(current.actor, permission);
            const receipt = await tx.adminCommandReceipt.findUnique({
              where: {
                accountId_idempotencyKey: {
                  accountId: current.actor.id,
                  idempotencyKey: key,
                },
              },
            });
            if (receipt) {
              if (
                receipt.action !== action ||
                receipt.target !== target ||
                receipt.requestDigest !== commandDigest
              )
                throw failure(409, 'ADMIN_IDEMPOTENCY_CONFLICT', '幂等键已用于其他请求');
              return receipt.result as unknown as T;
            }
            const { result, metadata } = await work(tx, current);
            await this.audit.write(
              tx,
              action,
              'allowed',
              current.actor.id,
              current.sessionId,
              result.resourceId,
              digest(input.reason),
              metadata,
            );
            await tx.adminCommandReceipt.create({
              data: {
                accountId: current.actor.id,
                sessionId: current.sessionId,
                idempotencyKey: key,
                action,
                target,
                requestDigest: commandDigest,
                result: result as unknown as Prisma.InputJsonObject,
              },
            });
            return result;
          }),
      );
    } catch (error) {
      if (error instanceof AppError && [403, 409, 422].includes(error.status)) {
        await this.db.transaction(async (tx) => {
          await lockAdmin(tx, `batch-denied:${context.actor.id}:${action}:${target}`);
          const recent = await tx.adminAuditEvent.findFirst({
            where: {
              accountId: context.actor.id,
              action,
              resourceId: target,
              outcome: 'denied',
              createdAt: { gt: new Date(Date.now() - 600_000) },
            },
          });
          if (!recent)
            await this.audit.write(
              tx,
              action,
              'denied',
              context.actor.id,
              context.sessionId,
              target,
              digest(input.reason),
              { code: error.code },
            );
        });
      }
      throw error;
    }
  }

  /** Reads the batch exactly as the customer-facing view projects it, never the stored counters. */
  private async load(tx: DbTransaction, runId: string) {
    const run = await tx.workflowRun.findUnique({ where: { id: runId } });
    if (!run) throw failure(404, 'BATCH_NOT_FOUND', '批次不存在');
    const items = await tx.workflowRunItem.findMany({
      where: { runId },
      include: { generationJob: { include: { items: true } } },
    });
    return { ownerId: run.userId, batch: presentRun(run, items) };
  }
}
