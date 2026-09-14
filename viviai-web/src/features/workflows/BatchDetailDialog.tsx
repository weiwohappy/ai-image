'use client';

import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import type { ImageAsset, TaskStatus, WorkflowRun } from '@/src/types/domain';

export const batchStatusLabel: Record<TaskStatus, string> = {
  queued: '批次排队中',
  processing: '批次处理中',
  succeeded: '批次完成',
  partial: '批次部分成功',
  failed: '批次失败',
  cancelled: '批次已取消',
};

const itemStatusLabel: Record<string, string> = {
  queued: '排队中',
  processing: '生成中',
  succeeded: '已完成',
  partial: '部分完成',
  failed: '失败',
  cancelled: '已取消',
};

export function BatchDetailDialog({
  run,
  assets,
  onOpenChange,
}: {
  run?: WorkflowRun;
  assets: ImageAsset[];
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={Boolean(run)} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl rounded-[24px] border-border bg-card p-6">
        <DialogTitle className="text-xl font-semibold">{run?.workflowName ?? '批次详情'}</DialogTitle>
        <DialogDescription>
          {run ? `版本 ${run.workflowVersion} · ${batchStatusLabel[run.status]} · 已扣 ${run.chargedCredits} / 预计 ${run.estimatedCredits} 积分` : ''}
        </DialogDescription>
        {run && (
          <div className="max-h-[60vh] overflow-y-auto rounded-xl border border-border">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-secondary/60 text-left text-xs text-muted-foreground">
                  <th className="p-2">行</th>
                  <th className="p-2">列</th>
                  <th className="p-2">状态</th>
                  <th className="p-2">结果</th>
                </tr>
              </thead>
              <tbody>
                {run.items.map((item) => {
                  const asset = assets.find((candidate) => candidate.id === item.resultAssetIds[0]);
                  return (
                    <tr key={item.id} className="border-t border-border">
                      <td className="p-2 font-mono text-xs text-muted-foreground">{item.rowKey.slice(-6)}</td>
                      <td className="p-2">{item.columnName ?? item.columnKey}</td>
                      <td className={`p-2 ${item.status === 'failed' ? 'text-destructive' : ''}`}>
                        {itemStatusLabel[item.status] ?? item.status}
                        {item.errorCode && <span className="ml-2 text-xs text-muted-foreground">{item.errorCode}</span>}
                        {item.status === 'failed' && !item.retryable && <span className="ml-2 text-xs">不可重试</span>}
                      </td>
                      <td className="p-2">
                        {asset ? (
                          <span className="flex items-center gap-2">
                            <img src={asset.thumbnailUrl} alt="" className="size-8 rounded object-cover" />
                            <span className="line-clamp-1 text-xs">{asset.name}</span>
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
