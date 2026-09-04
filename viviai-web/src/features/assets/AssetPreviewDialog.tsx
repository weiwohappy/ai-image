'use client';

import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import type { ImageAsset } from '@/src/types/domain';

export function AssetPreviewDialog({ asset, onClose }: { asset?: ImageAsset; onClose: () => void }) {
  return <Dialog open={Boolean(asset)} onOpenChange={(open) => { if (!open) onClose(); }}><DialogContent className="max-h-[90vh] max-w-4xl overflow-hidden rounded-[28px] border-border bg-card p-0 md:grid-cols-[1.4fr_.6fr]" showCloseButton>{asset && <><img src={asset.imageUrl} alt={asset.name} className="h-full max-h-[80vh] w-full bg-black/20 object-contain" /><div className="p-6"><p className="text-xs text-primary">{asset.source.toUpperCase()}</p><DialogTitle className="mt-2 pr-10 text-2xl font-semibold">{asset.name}</DialogTitle><DialogDescription className="mt-5 text-sm leading-6">{asset.prompt || '暂无提示词记录'}</DialogDescription><dl className="mt-6 grid grid-cols-2 gap-3 text-sm"><div className="rounded-xl bg-background p-3"><dt className="text-xs text-muted-foreground">尺寸</dt><dd className="mt-1 font-semibold">{asset.width} × {asset.height}</dd></div><div className="rounded-xl bg-background p-3"><dt className="text-xs text-muted-foreground">模型</dt><dd className="mt-1 font-semibold">{asset.modelId ?? '—'}</dd></div></dl></div></>}</DialogContent></Dialog>;
}
