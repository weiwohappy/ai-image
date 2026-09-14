'use client';

import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ImageAsset, Workflow, WorkflowRow } from '@/src/types/domain';

function WorkflowResultCell({ assetId, assets, status }: { assetId?: string; assets: ImageAsset[]; status?: string }) {
  const asset = assets.find((item) => item.id === assetId);
  if (asset)
    return (
      <div className="flex h-20 items-center gap-3 overflow-hidden rounded-xl border border-primary/20 bg-primary/5 p-2">
        <img src={asset.thumbnailUrl} alt="" className="size-16 shrink-0 rounded-lg object-cover" />
        <span className="line-clamp-2 text-xs text-foreground">{asset.name}</span>
      </div>
    );
  const label =
    status === 'processing' || status === 'queued'
      ? '正在生成…'
      : status === 'failed'
        ? '生成失败'
        : status === 'partial'
          ? '部分结果失败'
          : '运行后生成结果';
  return (
    <div
      className={`grid h-20 place-items-center rounded-xl border border-dashed bg-background text-xs ${status === 'failed' ? 'border-destructive/40 text-destructive' : 'border-border text-muted-foreground'}`}
    >
      {label}
    </div>
  );
}

export function WorkflowGrid({
  workflow,
  assets,
  selectedRowKeys,
  columnStatus,
  onChange,
  onToggleRow,
}: {
  workflow: Workflow;
  assets: ImageAsset[];
  selectedRowKeys: string[];
  /** Latest run item status per `columnKey:rowKey`, so result cells can show progress. */
  columnStatus?: Record<string, string>;
  onChange: (next: Workflow) => void;
  onToggleRow: (rowKey: string) => void;
}) {
  function updateRow(rowKey: string, patch: Partial<WorkflowRow>) {
    onChange({ ...workflow, rows: workflow.rows.map((row) => (row.rowKey === rowKey ? { ...row, ...patch } : row)) });
  }
  function removeRow(rowKey: string) {
    onChange({ ...workflow, rows: workflow.rows.filter((row) => row.rowKey !== rowKey) });
  }
  function addRow() {
    onChange({ ...workflow, rows: [...workflow.rows, { rowKey: `row-${crypto.randomUUID()}`, cells: {} }] });
  }
  return (
    <div className="overflow-x-auto rounded-[22px] border border-border bg-card">
      <table className="w-full min-w-[760px] border-collapse text-sm">
        <thead>
          <tr className="bg-secondary/60 text-left text-xs text-muted-foreground">
            <th className="w-12 p-3"><span className="sr-only">选择</span></th>
            <th className="w-16 p-3">行</th>
            {workflow.columns.map((column) => (
              <th key={column.id} className="min-w-48 border-l border-border p-3">
                <span className="block font-semibold text-foreground">{column.name}</span>
                <span className="mt-1 block font-normal">
                  {column.type === 'reference' ? '参考图' : column.type === 'tool' ? `${column.toolId} v${column.toolVersion}` : `${column.modelId} · ${column.resolution}`}
                </span>
              </th>
            ))}
            <th className="w-14 p-3"><span className="sr-only">操作</span></th>
          </tr>
        </thead>
        <tbody>
          {workflow.rows.map((row, index) => (
            <tr key={row.rowKey} className="border-t border-border">
              <td className="p-3 text-center">
                <input
                  type="checkbox"
                  aria-label={`选择第 ${index + 1} 行`}
                  checked={selectedRowKeys.includes(row.rowKey)}
                  onChange={() => onToggleRow(row.rowKey)}
                  className="size-4 accent-[var(--primary)]"
                />
              </td>
              <td className="p-3 text-muted-foreground">{String(index + 1).padStart(2, '0')}</td>
              {workflow.columns.map((column) => (
                <td key={column.id} className="border-l border-border p-3">
                  {column.type === 'reference' ? (
                    <select
                      aria-label={`${column.name}第 ${index + 1} 行`}
                      className="h-10 w-full rounded-xl border border-input bg-background px-3"
                      value={row.cells[column.id] ?? ''}
                      onChange={(event) => updateRow(row.rowKey, { cells: { ...row.cells, [column.id]: event.target.value } })}
                    >
                      <option value="">选择资产</option>
                      {assets.map((asset) => (
                        <option key={asset.id} value={asset.id}>{asset.name}</option>
                      ))}
                    </select>
                  ) : (
                    <WorkflowResultCell assetId={row.cells[column.id]} assets={assets} status={columnStatus?.[`${column.id}:${row.rowKey}`]} />
                  )}
                </td>
              ))}
              <td className="p-3">
                <Button type="button" size="icon-sm" variant="ghost" aria-label={`删除第 ${index + 1} 行`} disabled={workflow.rows.length <= 1} onClick={() => removeRow(row.rowKey)}>
                  <Trash2 />
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="border-t border-border p-3">
        <Button type="button" size="sm" variant="ghost" onClick={addRow}><Plus />添加一行</Button>
      </div>
    </div>
  );
}
