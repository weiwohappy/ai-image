'use client';

import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ImageAsset } from '@/src/types/domain';

export function AssetPreviewDialog({ asset, onClose }: { asset?: ImageAsset; onClose: () => void }) {
  if (!asset) return null;
  return <div role="dialog" aria-modal="true" aria-label={`预览 ${asset.name}`} className="fixed inset-0 z-50 grid place-items-center bg-black/75 p-4 backdrop-blur-sm" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="relative grid max-h-[90vh] w-full max-w-4xl overflow-hidden rounded-[28px] border border-border bg-card md:grid-cols-[1.4fr_.6fr]"><img src={asset.imageUrl} alt={asset.name} className="h-full max-h-[80vh] w-full object-contain bg-black/20" /><div className="p-6"><Button type="button" variant="ghost" size="icon" className="absolute right-3 top-3 rounded-full" aria-label="关闭预览" onClick={onClose}><X /></Button><p className="text-xs text-primary">{asset.source.toUpperCase()}</p><h2 className="mt-2 pr-10 text-2xl font-semibold">{asset.name}</h2><p className="mt-5 text-sm leading-6 text-muted-foreground">{asset.prompt}</p><dl className="mt-6 grid grid-cols-2 gap-3 text-sm"><div className="rounded-xl bg-background p-3"><dt className="text-xs text-muted-foreground">尺寸</dt><dd className="mt-1 font-semibold">{asset.width} × {asset.height}</dd></div><div className="rounded-xl bg-background p-3"><dt className="text-xs text-muted-foreground">模型</dt><dd className="mt-1 font-semibold">{asset.modelId ?? '—'}</dd></div></dl></div></section></div>;
}
