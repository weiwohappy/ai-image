import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService, type DbTransaction } from '../../shared/database/database.service.js';
import { safeInteger } from '../../shared/database/locks.js';
import { TERMINAL } from '../generation/job-serializer.js';
import { readRunSnapshot } from './workflow-presenter.js';

export const RUN_TERMINAL = ['succeeded', 'partial', 'failed', 'cancelled'];
export const RUN_ACTIVE = ['queued', 'processing'];
/** Failures a retry cannot fix, so a run never re-quotes them. */
const NOT_RETRYABLE = [
  'PROVIDER_CONTENT_REJECTED',
  'INVALID_PROVIDER_OUTPUT',
  'MODEL_UNAVAILABLE',
  'MODEL_SNAPSHOT_MISSING',
];

export function isRetryable(errorCode: string | null): boolean {
  return !errorCode || !NOT_RETRYABLE.includes(errorCode);
}

interface RunItemRecord {
  id: string;
  rowKey: string;
  columnKey: string;
  status: string;
  errorCode: string | null;
  generationJobId: string;
  generationJob: {
    items: Array<{
      status: string;
      errorCode: string | null;
      unitCredits: bigint;
      resultAssetId: string | null;
    }>;
  };
}

interface ProjectedItem {
  status: string;
  errorCode: string | null;
  retryable: boolean;
  estimatedCredits: number;
  chargedCredits: number;
  resultAssetIds: string[];
}

export interface RunCounts {
  status: string;
  totalCount: number;
  succeededCount: number;
  failedCount: number;
  cancelledCount: number;
}

/**
 * Projects linked generation jobs onto a batch run. Counts are always recomputed
 * from the jobs, never incremented, so duplicate worker events and repeated
 * recovery passes cannot double count.
 */
@Injectable()
export class BatchProjectionService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  async reconcile(tx: DbTransaction, runId: string): Promise<RunCounts | null> {
    const run = await tx.workflowRun.findUnique({ where: { id: runId } });
    if (!run) return null;
    const items = await this.items(tx, runId);
    for (const item of items) {
      const projected = projectItem(item);
      if (projected.status !== item.status || projected.errorCode !== item.errorCode)
        await tx.workflowRunItem.update({
          where: { id: item.id },
          data: { status: projected.status, errorCode: projected.errorCode },
        });
    }
    const counts = count(items);
    const status = deriveStatus(counts);
    await tx.workflowRun.update({ where: { id: runId }, data: { ...counts, status } });
    return { ...counts, status };
  }

  /** Batch detail: run counters plus each item's state and its task links. */
  async detail(tx: DbTransaction, userId: string, runId: string) {
    const run = await tx.workflowRun.findFirst({
      where: { id: runId, userId },
      include: { retries: { select: { id: true } } },
    });
    if (!run) return null;
    return presentRun(run, await this.items(tx, runId));
  }

  async list(tx: DbTransaction, userId: string) {
    const runs = await tx.workflowRun.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
    });
    const items = runs.length
      ? await tx.workflowRunItem.findMany({
          where: { runId: { in: runs.map((run) => run.id) } },
          include: { generationJob: { include: { items: true } } },
        })
      : [];
    const byRun = new Map<string, RunItemRecord[]>();
    for (const item of items) {
      const bucket = byRun.get(item.runId) ?? [];
      bucket.push(item);
      byRun.set(item.runId, bucket);
    }
    return runs.map((run) => presentRun(run, byRun.get(run.id) ?? []));
  }

  private items(tx: DbTransaction, runId: string) {
    return tx.workflowRunItem.findMany({
      where: { runId },
      orderBy: [{ rowKey: 'asc' }, { columnKey: 'asc' }],
      include: { generationJob: { include: { items: true } } },
    });
  }
}

/** A run item follows the outcome of the job it links. */
function projectItem(item: RunItemRecord): ProjectedItem {
  let estimatedCredits = 0;
  let chargedCredits = 0;
  const resultAssetIds: string[] = [];
  for (const entry of item.generationJob.items) {
    estimatedCredits += safeInteger(entry.unitCredits);
    if (entry.status === 'succeeded') chargedCredits += safeInteger(entry.unitCredits);
    if (entry.resultAssetId) resultAssetIds.push(entry.resultAssetId);
  }
  const statuses = item.generationJob.items.map((entry) => entry.status);
  const errorCode = item.generationJob.items.find((entry) => entry.errorCode)?.errorCode ?? null;
  const settled = statuses.filter((status) => TERMINAL.includes(status)).length;
  let status: string;
  if (!statuses.length || settled < statuses.length)
    status = statuses.every((entry) => entry === 'queued') ? 'queued' : 'processing';
  else {
    const succeeded = statuses.filter((entry) => entry === 'succeeded').length;
    status =
      succeeded === statuses.length
        ? 'succeeded'
        : succeeded > 0
          ? 'partial'
          : statuses.every((entry) => entry === 'cancelled')
            ? 'cancelled'
            : 'failed';
  }
  return {
    status,
    errorCode: status === 'succeeded' || status === 'cancelled' ? null : errorCode,
    retryable: isRetryable(errorCode),
    estimatedCredits,
    chargedCredits,
    resultAssetIds,
  };
}

function count(items: RunItemRecord[]): Omit<RunCounts, 'status'> {
  const projected = items.map(projectItem);
  return {
    totalCount: items.length,
    succeededCount: projected.filter((item) => item.status === 'succeeded').length,
    failedCount: projected.filter((item) => item.status === 'failed').length,
    cancelledCount: projected.filter((item) => item.status === 'cancelled').length,
  };
}

function deriveStatus(counts: Omit<RunCounts, 'status'>): string {
  const { totalCount, succeededCount, failedCount, cancelledCount } = counts;
  const settled = succeededCount + failedCount + cancelledCount;
  if (!totalCount) return 'queued';
  if (settled < totalCount) return settled ? 'processing' : 'queued';
  if (succeededCount === totalCount) return 'succeeded';
  if (cancelledCount === totalCount) return 'cancelled';
  return succeededCount > 0 ? 'partial' : 'failed';
}

interface RunRecord {
  id: string;
  workflowId: string | null;
  workflowSnapshot: unknown;
  cancelRequested: boolean;
  retryOfRunId: string | null;
  createdAt: Date;
  updatedAt: Date;
  retries?: Array<{ id: string }>;
}

export function presentRun(run: RunRecord, items: RunItemRecord[]) {
  const snapshot = readRunSnapshot(run.workflowSnapshot);
  const names = new Map(snapshot.columns.map((column) => [column.id, column.name]));
  const projected = items.map((item) => ({ item, state: projectItem(item) }));
  const counts = count(items);
  return {
    id: run.id,
    workflowId: run.workflowId,
    workflowName: snapshot.name,
    workflowVersion: snapshot.workflowVersion,
    status: deriveStatus(counts),
    ...counts,
    cancelRequested: run.cancelRequested,
    retryOfRunId: run.retryOfRunId,
    retryRunIds: (run.retries ?? []).map((retry) => retry.id),
    estimatedCredits: projected.reduce((sum, entry) => sum + entry.state.estimatedCredits, 0),
    chargedCredits: projected.reduce((sum, entry) => sum + entry.state.chargedCredits, 0),
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    childTaskIds: items.map((item) => item.generationJobId),
    items: projected.map(({ item, state }) => ({
      id: item.id,
      rowKey: item.rowKey,
      columnKey: item.columnKey,
      columnName: names.get(item.columnKey) ?? null,
      status: state.status,
      errorCode: state.errorCode,
      retryable: state.retryable,
      generationJobId: item.generationJobId,
      resultAssetIds: state.resultAssetIds,
    })),
  };
}

export type RunDto = ReturnType<typeof presentRun>;
