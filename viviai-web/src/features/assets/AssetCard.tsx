'use client';

import { Download, Heart, ImagePlus, MoreHorizontal, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ImageAsset } from '@/src/types/domain';

export function AssetCard({ asset, selected, onSelect, onPreview, onFavorite, onDelete, onUse }: { asset: ImageAsset; selected: boolean; onSelect: () => void; onPreview: () => void; onFavorite: () => void; onDelete: () => void; onUse: () => void }) {
  return (
    <article className={`group overflow-hidden rounded-[22px] border bg-card transition ${selected ? 'border-primary ring-2 ring-primary/15' : 'border-border hover:border-foreground/20'}`}>
      <button type="button" className="relative block w-full" onClick={onPreview} aria-label={`预览${asset.name}`}><img src={asset.thumbnailUrl} alt={asset.name} className="aspect-square w-full object-cover transition duration-300 group-hover:scale-[1.02]" /><span className="absolute left-3 top-3 rounded-full bg-black/55 px-2.5 py-1 text-xs text-white backdrop-blur">{asset.source === 'remix' ? '爆款复刻' : asset.source === 'tool' ? 'AI 工具' : asset.source === 'workflow' ? '工作流' : '图片生成'}</span></button>
      <div className="p-3.5"><div className="flex items-center gap-2"><label className="grid size-8 place-items-center"><input type="checkbox" aria-label={`选择${asset.name}`} checked={selected} onChange={onSelect} className="size-4 accent-[var(--primary)]" /></label><strong className="min-w-0 flex-1 truncate text-sm">{asset.name}</strong><Button type="button" size="icon-sm" variant="ghost" aria-label={`${asset.favorite ? '取消收藏' : '收藏'}${asset.name}`} onClick={onFavorite}><Heart className={asset.favorite ? 'fill-primary text-primary' : ''} /></Button></div><div className="mt-3 flex gap-1"><Button type="button" size="sm" variant="secondary" className="flex-1" onClick={onUse}><ImagePlus />作为参考图</Button><a href={asset.imageUrl} download={`${asset.name}.svg`} className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground" aria-label={`下载${asset.name}`}><Download className="size-4" /></a><Button type="button" size="icon-sm" variant="ghost" aria-label={`删除${asset.name}`} onClick={onDelete}><Trash2 /></Button><Button type="button" size="icon-sm" variant="ghost" aria-label={`更多${asset.name}`}><MoreHorizontal /></Button></div></div>
    </article>
  );
}
