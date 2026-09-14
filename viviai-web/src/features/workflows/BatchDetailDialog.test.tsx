import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkflowRun } from '@/src/types/domain';
import { BatchDetailDialog, batchStatusLabel } from './BatchDetailDialog';

afterEach(() => cleanup());

const run: WorkflowRun = {
  id: 'run-1',
  workflowId: 'workflow-1',
  workflowName: '商品批量主图',
  workflowVersion: 3,
  status: 'partial',
  totalCount: 2,
  succeededCount: 1,
  failedCount: 1,
  cancelledCount: 0,
  cancelRequested: false,
  retryOfRunId: null,
  retryRunIds: [],
  estimatedCredits: 8,
  chargedCredits: 4,
  createdAt: new Date('2026-09-14T10:00:00Z').toISOString(),
  updatedAt: new Date('2026-09-14T10:02:00Z').toISOString(),
  childTaskIds: ['task-1', 'task-2'],
  items: [
    { id: 'item-1', rowKey: 'row-1', columnKey: 'out', columnName: '主图', status: 'succeeded', errorCode: null, retryable: true, generationJobId: 'task-1', resultAssetIds: ['asset-1'] },
    { id: 'item-2', rowKey: 'row-2', columnKey: 'out', columnName: '主图', status: 'failed', errorCode: 'PROVIDER_CONTENT_REJECTED', retryable: false, generationJobId: 'task-2', resultAssetIds: [] },
  ],
};

const assets = [{ id: 'asset-1', name: '主图结果', imageUrl: 'data:,', thumbnailUrl: 'data:,', width: 1024, height: 1024, source: 'workflow' as const, favorite: false, createdAt: new Date().toISOString() }];

describe('batch detail dialog', () => {
  it('shows per-item status, error codes, retryability and results', () => {
    render(<BatchDetailDialog run={run} assets={assets} onOpenChange={vi.fn()} />);

    expect(screen.getByText('商品批量主图')).toBeVisible();
    expect(screen.getByText(/版本 3 · 批次部分成功 · 已扣 4 \/ 预计 8 积分/)).toBeVisible();
    expect(screen.getByText('PROVIDER_CONTENT_REJECTED')).toBeVisible();
    expect(screen.getByText('不可重试')).toBeVisible();
    expect(screen.getByText('主图结果')).toBeVisible();
  });

  it('labels every run status the server can report', () => {
    expect(batchStatusLabel).toEqual({
      queued: '批次排队中',
      processing: '批次处理中',
      succeeded: '批次完成',
      partial: '批次部分成功',
      failed: '批次失败',
      cancelled: '批次已取消',
    });
  });

  it('stays closed when no run is selected', () => {
    render(<BatchDetailDialog run={undefined} assets={[]} onOpenChange={vi.fn()} />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
