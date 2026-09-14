import type {
  GenerationTask,
  ImageAsset,
  NotificationItem,
  PointLedgerEntry,
  Workflow,
  WorkflowRun,
} from '@/src/types/domain';
import { createSeedDb, getFixtureVisual, type MockDatabase } from './fixtures';
import { resetReferenceUploads } from './referenceUploads';

const STORAGE_KEY = 'viviai-mock-db-v1';
const DEMO_CREDENTIAL_HASH = '0ead2060b65992dca4769af601a1b3a35ef38cfad2c2c465bb160ea764157c5d';
let memoryDb = createSeedDb();
let memoryCredentialHash = DEMO_CREDENTIAL_HASH;

export function getCredentialHash(): string {
  return memoryCredentialHash;
}

export function setCredentialHash(hash: string): void {
  memoryCredentialHash = hash;
}

function storageAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

export function loadDb(): MockDatabase {
  let migrated = false;
  if (storageAvailable()) {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        memoryDb = JSON.parse(stored) as MockDatabase;
      } catch {
        window.localStorage.removeItem(STORAGE_KEY);
      }
    }
  }
  if (!memoryDb.redeemedCodes) { memoryDb.redeemedCodes = []; migrated = true; }
  if (!memoryDb.toolQuotes) { memoryDb.toolQuotes = []; migrated = true; }
  if (!memoryDb.challenges) { memoryDb.challenges = []; migrated = true; }
  if (!memoryDb.redemptionAttempts) { memoryDb.redemptionAttempts = []; migrated = true; }
  if (!memoryDb.workflowRuns) { memoryDb.workflowRuns = []; migrated = true; }
  if (!memoryDb.workflowRunQuotes) { memoryDb.workflowRunQuotes = []; migrated = true; }
  if (!memoryDb.workflowRunKeys) { memoryDb.workflowRunKeys = []; migrated = true; }
  // Pre-`rowKey` workflows and their batches are not addressable by the current API.
  if (memoryDb.workflows?.some((workflow) => typeof workflow.version !== 'number')) { memoryDb.workflows = []; migrated = true; }
  const legacyDb = memoryDb as MockDatabase & { credentialHash?: string; batches?: unknown; workflows?: Workflow[] };
  if ('credentialHash' in legacyDb) { delete legacyDb.credentialHash; migrated = true; }
  if ('batches' in legacyDb) { delete legacyDb.batches; migrated = true; }
  if (reconcileDb(memoryDb) || migrated) {
    memoryDb = structuredClone(memoryDb);
    if (storageAvailable()) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(memoryDb));
  }
  return memoryDb;
}

export function saveDb(next: MockDatabase): MockDatabase {
  memoryDb = next;
  if (storageAvailable()) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }
  return next;
}

export function mutateDb(mutator: (draft: MockDatabase) => void): MockDatabase {
  const draft = structuredClone(loadDb());
  mutator(draft);
  return saveDb(draft);
}

export function resetDb(): MockDatabase {
  resetReferenceUploads();
  memoryDb = createSeedDb();
  memoryCredentialHash = DEMO_CREDENTIAL_HASH;
  if (storageAvailable()) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(memoryDb));
  }
  return memoryDb;
}

function createAsset(task: GenerationTask, index: number): ImageAsset {
  const createdAt = new Date().toISOString();
  return {
    id: `asset-${task.id}-${index + 1}`,
    name: task.input.prompt.slice(0, 18) || `生成图片 ${index + 1}`,
    imageUrl: getFixtureVisual(task.resultAssetIds.length + index + 2),
    thumbnailUrl: getFixtureVisual(task.resultAssetIds.length + index + 2),
    width: task.input.resolution === '4K' ? 4096 : task.input.resolution === '2K' ? 2048 : 1024,
    height: task.input.resolution === '4K' ? 4096 : task.input.resolution === '2K' ? 2048 : 1024,
    source: task.input.source === 'remix' ? 'remix' : task.input.source === 'tool' ? 'tool' : task.input.source === 'workflow' ? 'workflow' : 'generation',
    modelId: task.input.modelId,
    favorite: false,
    createdAt,
    prompt: task.input.prompt,
    templateId: task.templateId,
    templateVersion: task.templateVersion,
    remixStrength: task.remixStrength,
  };
}

function settleTaskInDb(db: MockDatabase, task: GenerationTask, outcome: 'success' | 'partial' | 'failure', now = new Date().toISOString()): void {
  if (task.status === 'cancelled' || task.status === 'succeeded' || task.status === 'failed' || task.status === 'partial') return;

  const user = db.user;
  user.frozenCredits = Math.max(0, user.frozenCredits - task.estimatedCredits);
  const unitPrice = task.estimatedCredits / task.input.count;
  const successCount = outcome === 'success' ? task.input.count : outcome === 'partial' ? Math.max(1, task.input.count - 1) : 0;
  const charged = unitPrice * successCount;
  const refund = task.estimatedCredits - charged;

  if (refund > 0) user.credits += refund;
  task.chargedCredits = charged;
  task.progress = 100;
  task.updatedAt = now;

  if (outcome === 'failure') {
    task.status = 'failed';
    task.errorCode = 'TASK_TIMEOUT';
    task.errorMessage = '模型响应超时，冻结积分已退回。';
  } else {
    task.status = outcome === 'partial' ? 'partial' : 'succeeded';
    const createdAssets = Array.from({ length: successCount }, (_, index) => createAsset(task, index));
    task.resultAssetIds = createdAssets.map((asset) => asset.id);
    db.assets.unshift(...createdAssets);
  }

  if (task.workflowId && task.workflowRowId && task.workflowColumnId) {
    const workflow = db.workflows.find((item) => item.id === task.workflowId);
    const row = workflow?.rows.find((item) => item.rowKey === task.workflowRowId);
    if (row && task.resultAssetIds[0]) row.cells[task.workflowColumnId] = task.resultAssetIds[0];
  }

  const ledger: PointLedgerEntry = {
    id: `ledger-${crypto.randomUUID()}`,
    type: refund > 0 ? 'refund' : 'consume',
    description: outcome === 'failure' ? '生成失败退回' : outcome === 'partial' ? '部分成功结算' : '图片生成结算',
    delta: refund,
    balance: user.credits,
    createdAt: task.updatedAt,
  };
  db.ledger.unshift(ledger);

  const notification: NotificationItem = {
    id: `notice-${crypto.randomUUID()}`,
    type: 'task',
    title: outcome === 'failure' ? '生成失败' : outcome === 'partial' ? '部分图片已生成' : '生成成功',
    content: outcome === 'failure' ? '积分已经自动退回，可以重新尝试。' : `已完成 ${successCount} 张图片。`,
    read: false,
    createdAt: task.updatedAt,
    href: '/create',
  };
  db.notifications.unshift(notification);
}

const RETRYABLE_FAILURES = ['PROVIDER_CONTENT_REJECTED', 'INVALID_PROVIDER_OUTPUT', 'MODEL_UNAVAILABLE', 'MODEL_SNAPSHOT_MISSING'];

/** Projects the linked generation tasks onto one run, mirroring the server projection. */
function reconcileRun(db: MockDatabase, run: WorkflowRun): boolean {
  const before = JSON.stringify({ items: run.items, status: run.status, charged: run.chargedCredits });
  run.items = run.items.flatMap((item) => {
    const task = db.tasks.find((candidate) => candidate.id === item.generationJobId);
    if (!task) return [];
    return [
      {
        ...item,
        status: task.status,
        errorCode: task.errorCode ?? null,
        retryable: !task.errorCode || !RETRYABLE_FAILURES.includes(task.errorCode),
        resultAssetIds: task.resultAssetIds,
      },
    ];
  });
  run.succeededCount = run.items.filter((item) => item.status === 'succeeded').length;
  run.failedCount = run.items.filter((item) => item.status === 'failed').length;
  run.cancelledCount = run.items.filter((item) => item.status === 'cancelled').length;
  run.totalCount = run.items.length;
  run.chargedCredits = run.items.reduce((total, item) => {
    const task = db.tasks.find((candidate) => candidate.id === item.generationJobId);
    return total + (task?.chargedCredits ?? 0);
  }, 0);
  const settled = run.succeededCount + run.failedCount + run.cancelledCount;
  run.status =
    settled < run.totalCount
      ? settled > 0 || run.cancelRequested
        ? 'processing'
        : 'queued'
      : run.cancelledCount === run.totalCount
        ? 'cancelled'
        : run.succeededCount === run.totalCount
          ? 'succeeded'
          : run.succeededCount > 0
            ? 'partial'
            : 'failed';
  run.updatedAt = new Date().toISOString();
  return before !== JSON.stringify({ items: run.items, status: run.status, charged: run.chargedCredits });
}

function reconcileWorkflowRows(db: MockDatabase): boolean {
  let changed = false;
  for (const workflow of db.workflows) {
    for (const row of workflow.rows) {
      const runs = db.workflowRuns.filter((run) => run.workflowId === workflow.id);
      for (const run of runs) {
        for (const item of run.items) {
          if (item.rowKey !== row.rowKey) continue;
          const task = db.tasks.find((candidate) => candidate.id === item.generationJobId);
          const assetId = task?.resultAssetIds[0];
          if (assetId && row.cells[item.columnKey] !== assetId) {
            row.cells[item.columnKey] = assetId;
            changed = true;
          }
        }
      }
    }
  }
  return changed;
}

function reconcileDb(db: MockDatabase): boolean {
  const nowMs = Date.now();
  let changed = false;
  for (const task of db.tasks) {
    if (task.status !== 'queued' && task.status !== 'processing') continue;
    if (!task.mockLifecycle) {
      settleTaskInDb(db, task, 'failure', new Date().toISOString());
      task.errorCode = 'INTERNAL_ERROR';
      task.errorMessage = '演示数据已升级，旧任务的冻结积分已自动退回。';
      changed = true;
      continue;
    }
    if (nowMs >= Date.parse(task.mockLifecycle.completionAt)) {
      settleTaskInDb(db, task, task.mockLifecycle.outcome, new Date().toISOString());
      changed = true;
    } else if (nowMs >= Date.parse(task.mockLifecycle.processingAt) && task.status === 'queued') {
      task.status = 'processing';
      task.progress = 52;
      task.updatedAt = new Date().toISOString();
      changed = true;
    }
  }
  for (const run of db.workflowRuns) changed = reconcileRun(db, run) || changed;
  changed = reconcileWorkflowRows(db) || changed;
  return changed;
}

export function settleTask(taskId: string, outcome: 'success' | 'partial' | 'failure'): void {
  mutateDb((db) => {
    const task = db.tasks.find((candidate) => candidate.id === taskId);
    if (task) settleTaskInDb(db, task, outcome);
  });
}
