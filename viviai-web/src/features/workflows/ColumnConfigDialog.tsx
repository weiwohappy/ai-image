'use client';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import type { ImageRatio, ModelConfig, Resolution, WorkflowGenerationColumn, WorkflowReferenceColumn } from '@/src/types/domain';

export function ColumnConfigDialog({
  column,
  models,
  referenceColumns,
  onChange,
  onClose,
}: {
  column?: WorkflowGenerationColumn;
  models: ModelConfig[];
  referenceColumns: WorkflowReferenceColumn[];
  onChange: (next: WorkflowGenerationColumn) => void;
  onClose: () => void;
}) {
  const available = models.filter((model) => model.status === 'available');
  const model = available.find((item) => item.id === column?.modelId);
  // A model swap must land on a combination the model actually offers.
  function changeModel(modelId: string) {
    if (!column) return;
    const next = available.find((item) => item.id === modelId);
    onChange({
      ...column,
      modelId,
      resolution: next && !next.resolutions.includes(column.resolution) ? (next.resolutions[0] ?? column.resolution) : column.resolution,
      ratio: next && !next.ratios.includes(column.ratio) ? (next.ratios[0] ?? column.ratio) : column.ratio,
    });
  }
  return (
    <Dialog open={Boolean(column)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg rounded-[24px] border-border bg-card p-6">
        <DialogTitle className="text-xl font-semibold">配置生成列</DialogTitle>
        <DialogDescription>设置该列的参考素材、提示词、模型与输出规格。</DialogDescription>
        {column && (
          <>
            <label className="mt-2 block text-sm">
              列名称
              <Input className="mt-2 h-11 bg-background" value={column.name} onChange={(event) => onChange({ ...column, name: event.target.value })} />
            </label>
            <label className="mt-2 block text-sm">
              统一提示词
              <Input className="mt-2 h-11 bg-background" value={column.prompt} onChange={(event) => onChange({ ...column, prompt: event.target.value })} />
            </label>
            {referenceColumns.length > 0 && (
              <fieldset className="mt-2">
                <legend className="text-sm">引用参考列</legend>
                <div className="mt-2 flex flex-wrap gap-2">
                  {referenceColumns.map((reference) => {
                    const active = column.sourceColumnIds.includes(reference.id);
                    return (
                      <label key={reference.id} className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${active ? 'border-primary/40 bg-primary/8' : 'border-border bg-background'}`}>
                        <input
                          type="checkbox"
                          checked={active}
                          onChange={() => onChange({ ...column, sourceColumnIds: active ? column.sourceColumnIds.filter((id) => id !== reference.id) : [...column.sourceColumnIds, reference.id] })}
                        />
                        {reference.name}
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            )}
            <div className="mt-2 grid grid-cols-3 gap-2">
              <label className="text-sm">
                模型
                <select aria-label="模型" className="mt-2 h-10 w-full rounded-lg border border-input bg-background px-2" value={column.modelId} onChange={(event) => changeModel(event.target.value)}>
                  {available.map((item) => (
                    <option key={item.id} value={item.id}>{item.name}</option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                分辨率
                <select aria-label="分辨率" className="mt-2 h-10 w-full rounded-lg border border-input bg-background px-2" value={column.resolution} onChange={(event) => onChange({ ...column, resolution: event.target.value as Resolution })}>
                  {(model?.resolutions ?? [column.resolution]).map((resolution) => (
                    <option key={resolution} value={resolution}>{resolution}</option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                比例
                <select aria-label="比例" className="mt-2 h-10 w-full rounded-lg border border-input bg-background px-2" value={column.ratio} onChange={(event) => onChange({ ...column, ratio: event.target.value as ImageRatio })}>
                  {(model?.ratios ?? [column.ratio]).map((ratio) => (
                    <option key={ratio} value={ratio}>{ratio}</option>
                  ))}
                </select>
              </label>
            </div>
            <Button type="button" className="mt-2 w-full" onClick={onClose}>完成配置</Button>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
