'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Grid2X2, Heart, Search, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/src/services/api';
import { queryKeys } from '@/src/services/queryKeys';
import { useSessionStore } from '@/src/stores/sessionStore';
import type { ImageAsset } from '@/src/types/domain';
import { AssetCard } from './AssetCard';
import { AssetPreviewDialog } from './AssetPreviewDialog';

export function AssetsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const updateDraft = useSessionStore((state) => state.updateGenerationDraft);
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('');
  const [favorite, setFavorite] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<ImageAsset>();
  const [deleted, setDeleted] = useState<ImageAsset>();
  const filters = { query, source, favorite: favorite || undefined };
  const assets = useQuery({ queryKey: [...queryKeys.assets, filters], queryFn: () => api.listAssets(filters) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.assets });
  const update = useMutation({ mutationFn: ({ id, patch }: { id: string; patch: Partial<Pick<ImageAsset, 'favorite' | 'name'>> }) => api.updateAsset(id, patch), onSuccess: refresh });
  const remove = useMutation({ mutationFn: api.deleteAsset, onSuccess: (asset) => { setDeleted(asset); refresh(); } });
  const restore = useMutation({ mutationFn: api.restoreAsset, onSuccess: () => { setDeleted(undefined); refresh(); } });
  function useAsReference(asset: ImageAsset) { updateDraft({ referenceAssetId: asset.id }); navigate('/create'); }

  return (
    <main className="mx-auto w-full max-w-[1540px] p-4 md:p-6 xl:p-8">
      <header className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-sm font-medium text-primary">ASSET LIBRARY</p><h1 className="mt-1 text-3xl font-semibold tracking-[-.04em] md:text-4xl">我的资产</h1><p className="mt-2 text-base text-muted-foreground">统一管理生成、复刻、工具和工作流产出的图片。</p></div><div className="flex items-center gap-2 text-sm text-muted-foreground"><Grid2X2 className="size-4" />{assets.data?.length ?? 0} 个结果</div></header>
      <section className="mt-7 flex flex-wrap gap-3 rounded-2xl border border-border bg-card p-3"><label className="relative min-w-[220px] flex-1"><Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input aria-label="搜索资产" className="h-10 rounded-xl bg-background pl-10" placeholder="搜索名称" value={query} onChange={(event) => setQuery(event.target.value)} /></label><select aria-label="来源筛选" className="h-10 rounded-xl border border-input bg-background px-3 text-sm" value={source} onChange={(event) => setSource(event.target.value)}><option value="">全部来源</option><option value="generation">图片生成</option><option value="remix">爆款复刻</option><option value="tool">AI 工具</option><option value="workflow">工作流</option></select><Button type="button" variant={favorite ? 'default' : 'outline'} className="h-10 rounded-xl" onClick={() => setFavorite((value) => !value)}><Heart />只看收藏</Button></section>
      {selected.length > 0 && <div className="sticky top-20 z-20 mt-4 flex items-center justify-between rounded-2xl border border-primary/20 bg-[#25271f]/95 px-4 py-3 shadow-xl backdrop-blur"><span className="text-sm">已选择 <strong className="text-primary">{selected.length}</strong> 项</span><Button type="button" size="sm" variant="ghost" onClick={() => setSelected([])}>取消选择</Button></div>}
      {assets.isPending ? <div className="mt-6 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">{Array.from({ length: 8 }).map((_, index) => <div key={index} className="aspect-square animate-pulse rounded-[22px] bg-card" />)}</div> : assets.data?.length ? <div className="mt-6 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">{assets.data.map((asset) => <AssetCard key={asset.id} asset={asset} selected={selected.includes(asset.id)} onSelect={() => setSelected((current) => current.includes(asset.id) ? current.filter((id) => id !== asset.id) : [...current, asset.id])} onPreview={() => setPreview(asset)} onFavorite={() => update.mutate({ id: asset.id, patch: { favorite: !asset.favorite } })} onDelete={() => remove.mutate(asset.id)} onUse={() => useAsReference(asset)} />)}</div> : <div className="mt-8 grid min-h-72 place-items-center rounded-[24px] border border-dashed border-border text-center"><div><Trash2 className="mx-auto size-8 text-muted-foreground" /><h2 className="mt-4 text-lg font-semibold">没有匹配的资产</h2><p className="mt-2 text-sm text-muted-foreground">试试调整关键词或筛选条件。</p></div></div>}
      {deleted && <div role="status" className="fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-4 rounded-full border border-border bg-popover px-4 py-2.5 text-sm shadow-2xl"><span>已删除“{deleted.name}”</span><button type="button" className="font-semibold text-primary" onClick={() => restore.mutate(deleted.id)}>撤销</button></div>}
      <AssetPreviewDialog asset={preview} onClose={() => setPreview(undefined)} />
    </main>
  );
}
