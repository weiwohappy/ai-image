'use client';

import { RotateCcw, Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import type { GenerationTask, ImageAsset } from '@/src/types/domain';

const statusLabels = { queued: '正在排队', processing: '正在生成', succeeded: '生成成功', partial: '部分成功', failed: '生成失败', cancelled: '已取消' } as const;

export function GenerationCard({ task, assets, onRetry, onCancel }: { task: GenerationTask; assets: ImageAsset[]; onRetry?: () => void; onCancel?: () => void }) {
  const results = task.resultAssetIds.map((id) => assets.find((asset) => asset.id === id)).filter(Boolean) as ImageAsset[];
  const active = task.status === 'queued' || task.status === 'processing';
  return (
    <article className="overflow-hidden rounded-[22px] border border-border bg-background">
      {results.length ? <div className={`grid ${results.length > 1 ? 'grid-cols-2' : ''}`}>{results.map((asset) => <img key={asset.id} src={asset.imageUrl} alt={asset.name} className="aspect-square w-full object-cover" />)}</div> : <div className="relative grid aspect-[4/3] place-items-center overflow-hidden bg-[radial-gradient(circle_at_70%_20%,rgba(216,255,82,.13),transparent_28%),linear-gradient(135deg,#24251f,#171813)]"><Sparkles className={`size-8 text-primary ${active ? 'animate-pulse' : ''}`} /></div>}
      <div className="p-4"><div className="flex items-center justify-between gap-3"><strong className={task.status === 'failed' ? 'text-destructive' : task.status === 'succeeded' ? 'text-primary' : ''}>{statusLabels[task.status]}</strong><span className="text-xs text-muted-foreground">{task.input.resolution} · {task.input.ratio}</span></div><p className="mt-2 line-clamp-2 text-sm leading-6 text-muted-foreground">{task.input.prompt}</p>{active && <Progress className="mt-3" value={task.progress} aria-label={`生成进度 ${task.progress}%`} />}{task.errorMessage && <p className="mt-2 text-sm text-destructive">{task.errorMessage}</p>}{(active || task.status === 'failed') && <div className="mt-3 flex gap-2">{task.status === 'failed' && onRetry && <Button type="button" size="sm" variant="outline" onClick={onRetry}><RotateCcw />重试</Button>}{active && onCancel && <Button type="button" size="sm" variant="ghost" onClick={onCancel}><X />取消任务</Button>}</div>}</div>
    </article>
  );
}
