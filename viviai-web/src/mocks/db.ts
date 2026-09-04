import type { GenerationTask, ImageAsset, NotificationItem, PointLedgerEntry } from '@/src/types/domain';
import { createSeedDb, getFixtureVisual, type MockDatabase } from './fixtures';

const STORAGE_KEY = 'viviai-mock-db-v1';
let memoryDb = createSeedDb();

function storageAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

export function loadDb(): MockDatabase {
  if (!storageAvailable()) return memoryDb;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (!stored) return memoryDb;
  try {
    memoryDb = JSON.parse(stored) as MockDatabase;
  } catch {
    window.localStorage.removeItem(STORAGE_KEY);
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
  };
}

export function settleTask(taskId: string, outcome: 'success' | 'partial' | 'failure'): void {
  mutateDb((db) => {
    const task = db.tasks.find((candidate) => candidate.id === taskId);
    if (!task || task.status === 'cancelled' || task.status === 'succeeded' || task.status === 'failed') return;

    const user = db.user;
    user.frozenCredits = Math.max(0, user.frozenCredits - task.estimatedCredits);
    const unitPrice = task.estimatedCredits / task.input.count;
    const successCount = outcome === 'success' ? task.input.count : outcome === 'partial' ? Math.max(1, task.input.count - 1) : 0;
    const charged = unitPrice * successCount;
    const refund = task.estimatedCredits - charged;

    if (refund > 0) user.credits += refund;
    task.chargedCredits = charged;
    task.progress = 100;
    task.updatedAt = new Date().toISOString();

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
  });
}
