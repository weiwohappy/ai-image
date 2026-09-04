'use client';

import type { ReactNode } from 'react';
import type { GenerationDraft } from '@/src/stores/sessionStore';
import type { ModelConfig, OutputCount, Quality, Resolution, ImageRatio } from '@/src/types/domain';

const counts: OutputCount[] = [1, 2, 3, 4];

export function ModelParameterPanel({ models, draft, onChange }: { models: ModelConfig[]; draft: GenerationDraft; onChange: (patch: Partial<GenerationDraft>) => void }) {
  const model = models.find((item) => item.id === draft.modelId) ?? models[0];
  if (!model) return <div className="h-32 animate-pulse rounded-2xl bg-secondary" aria-label="正在加载模型" />;

  function selectModel(modelId: string) {
    const next = models.find((item) => item.id === modelId);
    if (!next) return;
    onChange({ modelId, resolution: next.resolutions[0], ratio: next.ratios.includes(draft.ratio) ? draft.ratio : next.ratios[0], quality: next.qualities?.[0] });
  }

  return (
    <div className="mt-5 grid grid-cols-2 gap-3 text-sm">
      <Parameter label="模型"><select aria-label="模型" value={model.id} onChange={(event) => selectModel(event.target.value)}>{models.filter((item) => item.status === 'available').map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Parameter>
      <Parameter label="清晰度"><select aria-label="清晰度" value={draft.resolution} onChange={(event) => onChange({ resolution: event.target.value as Resolution })}>{model.resolutions.map((item) => <option key={item}>{item}</option>)}</select></Parameter>
      {model.qualities && <Parameter label="质量"><select aria-label="质量" value={draft.quality ?? model.qualities[0]} onChange={(event) => onChange({ quality: event.target.value as Quality })}>{model.qualities.map((item) => <option key={item} value={item}>{item === 'high' ? '高' : item === 'medium' ? '标准' : '快速'}</option>)}</select></Parameter>}
      <Parameter label="画面比例"><select aria-label="画面比例" value={draft.ratio} onChange={(event) => onChange({ ratio: event.target.value as ImageRatio })}>{model.ratios.map((item) => <option key={item}>{item}</option>)}</select></Parameter>
      <Parameter label="生成张数"><select aria-label="生成张数" value={draft.count} onChange={(event) => onChange({ count: Number(event.target.value) as OutputCount })}>{counts.map((count) => <option key={count} value={count}>{count} 张</option>)}</select></Parameter>
    </div>
  );
}

function Parameter({ label, children }: { label: string; children: ReactNode }) {
  return <label className="rounded-xl border border-border bg-background px-3 py-2.5"><span className="block text-xs text-muted-foreground">{label}</span><span className="mt-1 block [&_select]:w-full [&_select]:bg-transparent [&_select]:font-semibold [&_select]:outline-none">{children}</span></label>;
}
