'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Input } from '@/components/ui/input';
import { api, type ContentPage } from '@/src/services/api';
import { queryKeys } from '@/src/services/queryKeys';
import { useSessionStore } from '@/src/stores/sessionStore';
import type { Inspiration } from '@/src/types/domain';
import { InspirationCard } from './InspirationCard';

const categories = ['全部', '电商视觉', '摄影写真', '平面设计', '插画漫画', '影视', '建筑家装'];

export function InspirationPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const updateDraft = useSessionStore((state) => state.updateGenerationDraft);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('全部');
  // "全部" is the absence of a filter; the catalog endpoint matches categories literally.
  const params = { query, category: category === '全部' ? undefined : category };
  const inspirations = useQuery({ queryKey: [...queryKeys.inspirations, params], queryFn: () => api.listInspirations(params) });
  // The like endpoints are authoritative and return the updated card, so patch it in place
  // instead of refetching the whole page.
  const like = useMutation({
    mutationFn: (item: Inspiration) => (item.liked ? api.unlikeInspiration(item.id) : api.likeInspiration(item.id)),
    onSuccess: (updated) => queryClient.setQueryData<ContentPage<Inspiration>>([...queryKeys.inspirations, params], (page) => page && { ...page, items: page.items.map((item) => (item.id === updated.id ? updated : item)) }),
  });
  return <main className="mx-auto w-full max-w-[1540px] p-4 md:p-6 xl:p-8"><header className="flex flex-wrap items-end justify-between gap-5"><div><p className="flex items-center gap-2 text-sm font-medium text-primary"><Sparkles className="size-4" />CURATED INSPIRATION</p><h1 className="mt-2 text-3xl font-semibold tracking-[-.045em] md:text-4xl">灵感发现</h1><p className="mt-2 text-base text-muted-foreground">从优秀作品提取提示词，再生成属于你的版本。</p></div><label className="relative w-full max-w-md"><Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input aria-label="搜索灵感" className="h-11 rounded-full bg-card pl-10" placeholder="搜索场景、品类或风格" value={query} onChange={(event) => setQuery(event.target.value)} /></label></header><nav className="mt-7 flex gap-2 overflow-x-auto pb-2" aria-label="灵感分类">{categories.map((item) => <button type="button" key={item} className={`shrink-0 rounded-full px-4 py-2 text-sm ${category === item ? 'bg-primary font-semibold text-primary-foreground' : 'border border-border bg-card text-muted-foreground hover:text-foreground'}`} onClick={() => setCategory(item)}>{item}</button>)}</nav><div className="mt-5 columns-2 gap-4 md:columns-3 xl:columns-4">{inspirations.data?.items.map((item) => <InspirationCard key={item.id} item={item} onLike={() => like.mutate(item)} onRemix={() => { updateDraft({ prompt: item.prompt }); navigate('/create'); }} />)}</div></main>;
}
