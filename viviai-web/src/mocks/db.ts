import type { GenerationTask, ImageAsset, NotificationItem, PointLedgerEntry } from '@/src/types/domain';
import { createSeedDb, getFixtureVisual, type MockDatabase } from './fixtures';

const STORAGE_KEY = 'viviai-mock-db-v1';
const DEMO_CREDENTIAL_HASH = '0ead2060b65992dca4769af601a1b3a35ef38cfad2c2c465bb160ea764157c5d';
let memoryDb = createSeedDb();

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
  if (!memoryDb.credentialHash) { memoryDb.credentialHash = DEMO_CREDENTIAL_HASH; migrated = true; }
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
  memoryDb = createSeedDb();
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
    const row = workflow?.rows.find((item) => item.id === task.workflowRowId);
    if (row && task.resultAssetIds[0]) row.cells[task.workflowColumnId] = task.resultAssetIds[0];
    if (row) {
      const siblings = db.tasks.filter((item) => item.workflowId === task.workflowId && item.workflowRowId === task.workflowRowId);
      const active = siblings.some((item) => item.status === 'queued' || item.status === 'processing');
      const failed = siblings.filter((item) => item.status === 'failed' || item.status === 'cancelled').length;
      const partial = siblings.some((item) => item.status === 'partial');
      row.status = active ? 'processing' : failed === siblings.length ? 'failed' : failed > 0 || partial ? 'partial' : 'succeeded';
    }
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

function reconcileBatch(db: MockDatabase, batchId: string): boolean {
  const batch = db.batches.find((candidate) => candidate.id === batchId);
  if (!batch) return false;
  if (!batch.childTaskIds?.length) {
    if (batch.status !== 'queued' && batch.status !== 'processing') return false;
    Object.assign(batch, { completed: 0, processing: 0, failed: batch.total, status: 'failed' });
    return true;
  }
  const children = batch.childTaskIds.map((id) => db.tasks.find((task) => task.id === id)).filter(Boolean) as GenerationTask[];
  const completed = children.filter((task) => task.status === 'succeeded' || task.status === 'partial').length;
  const processing = children.filter((task) => task.status === 'queued' || task.status === 'processing').length;
  const failed = children.filter((task) => task.status === 'failed' || task.status === 'cancelled').length;
  const hasPartial = children.some((task) => task.status === 'partial');
  const status = processing > 0 ? 'processing' : failed === children.length ? 'failed' : failed > 0 || hasPartial ? 'partial' : 'succeeded';
  if (batch.completed === completed && batch.processing === processing && batch.failed === failed && batch.status === status) return false;
  Object.assign(batch, { completed, processing, failed, status });
  return true;
}

function reconcileWorkflowRows(db: MockDatabase): boolean {
  let changed = false;
  for (const workflow of db.workflows) {
    for (const row of workflow.rows) {
      const tasks = db.tasks.filter((task) => task.workflowId === workflow.id && task.workflowRowId === row.id);
      if (!tasks.length) continue;
      for (const task of tasks) {
        if (task.workflowColumnId && task.resultAssetIds[0] && row.cells[task.workflowColumnId] !== task.resultAssetIds[0]) {
          row.cells[task.workflowColumnId] = task.resultAssetIds[0];
          changed = true;
        }
      }
      const active = tasks.some((task) => task.status === 'queued' || task.status === 'processing');
      const failed = tasks.filter((task) => task.status === 'failed' || task.status === 'cancelled').length;
      const partial = tasks.some((task) => task.status === 'partial');
      const status = active ? 'processing' : failed === tasks.length ? 'failed' : failed > 0 || partial ? 'partial' : 'succeeded';
      if (row.status !== status) {
        row.status = status;
        changed = true;
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
  for (const batch of db.batches) changed = reconcileBatch(db, batch.id) || changed;
  changed = reconcileWorkflowRows(db) || changed;
  return changed;
}

export function settleTask(taskId: string, outcome: 'success' | 'partial' | 'failure'): void {
  mutateDb((db) => {
    const task = db.tasks.find((candidate) => candidate.id === taskId);
    if (task) settleTaskInDb(db, task, outcome);
  });
}
