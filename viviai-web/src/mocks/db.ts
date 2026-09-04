import type { GenerationTask, ImageAsset, NotificationItem, PointLedgerEntry } from '@/src/types/domain';
import { createSeedDb, getFixtureVisual, type MockDatabase } from './fixtures';

const STORAGE_KEY = 'viviai-mock-db-v1';
let memoryDb = createSeedDb();

function storageAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

export function loadDb(): MockDatabase {
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
  if (!memoryDb.redeemedCodes) memoryDb.redeemedCodes = [];
  if (reconcileDb(memoryDb)) {
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
      href: '#/create',
    };
    db.notifications.unshift(notification);
}

function reconcileBatch(db: MockDatabase, batchId: string): boolean {
  const batch = db.batches.find((candidate) => candidate.id === batchId);
  if (!batch?.childTaskIds?.length) return false;
  const children = batch.childTaskIds.map((id) => db.tasks.find((task) => task.id === id)).filter(Boolean) as GenerationTask[];
  const completed = children.filter((task) => task.status === 'succeeded' || task.status === 'partial').length;
  const processing = children.filter((task) => task.status === 'queued' || task.status === 'processing').length;
  const failed = children.filter((task) => task.status === 'failed' || task.status === 'cancelled').length;
  const status = processing > 0 ? 'processing' : failed === children.length ? 'failed' : failed > 0 ? 'partial' : 'succeeded';
  if (batch.completed === completed && batch.processing === processing && batch.failed === failed && batch.status === status) return false;
  Object.assign(batch, { completed, processing, failed, status });
  return true;
}

function reconcileDb(db: MockDatabase): boolean {
  const nowMs = Date.now();
  let changed = false;
  for (const task of db.tasks) {
    if ((task.status !== 'queued' && task.status !== 'processing') || !task.mockLifecycle) continue;
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
  return changed;
}

export function settleTask(taskId: string, outcome: 'success' | 'partial' | 'failure'): void {
  mutateDb((db) => {
    const task = db.tasks.find((candidate) => candidate.id === taskId);
    if (task) settleTaskInDb(db, task, outcome);
  });
}
