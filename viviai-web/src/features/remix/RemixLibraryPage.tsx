'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, WandSparkles } from 'lucide-react';
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { api, type ContentPage } from '@/src/services/api';
import { queryKeys } from '@/src/services/queryKeys';
import type { ViralTemplate } from '@/src/types/domain';
import { TemplateCard } from './TemplateCard';

export function RemixLibraryPage() {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [platform, setPlatform] = useState('');
  const [style, setStyle] = useState('');
  const filters = { query, platform, style };
  const templates = useQuery({ queryKey: [...queryKeys.templates, filters], queryFn: () => api.listTemplates(filters) });
  // The favorite endpoints are authoritative and return the updated card, so patch it in place
  // instead of refetching the whole page.
  const favorite = useMutation({
    mutationFn: (template: ViralTemplate) => (template.favorite ? api.unfavoriteTemplate(template.id) : api.favoriteTemplate(template.id)),
    onSuccess: (updated) => queryClient.setQueryData<ContentPage<ViralTemplate>>([...queryKeys.templates, filters], (page) => page && { ...page, items: page.items.map((template) => (template.id === updated.id ? updated : template)) }),
  });
  return <main className="mx-auto w-full max-w-[1540px] p-4 md:p-6 xl:p-8"><header className="max-w-3xl"><p className="flex items-center gap-2 text-sm font-medium text-violet-300"><WandSparkles className="size-4" />VIRAL REMIX</p><h1 className="mt-2 text-3xl font-semibold tracking-[-.045em] md:text-5xl">借鉴爆款结构，<span className="text-violet-300">生成你的新作品</span></h1><p className="mt-4 text-base leading-7 text-muted-foreground">参考的是构图、色彩和视觉动线，不复制原图品牌、文案或人物身份。</p></header><section className="mt-8 flex flex-wrap gap-3 rounded-2xl border border-border bg-card p-3"><label className="relative min-w-[240px] flex-1"><Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input aria-label="搜索爆款模板" className="h-10 rounded-xl bg-background pl-10" placeholder="搜索品类、风格或关键词" value={query} onChange={(event) => setQuery(event.target.value)} /></label><select aria-label="平台" className="h-10 rounded-xl border border-input bg-background px-3 text-sm" value={platform} onChange={(event) => setPlatform(event.target.value)}><option value="">全部平台</option><option>小红书</option><option>淘宝</option><option>抖音</option></select><select aria-label="风格" className="h-10 rounded-xl border border-input bg-background px-3 text-sm" value={style} onChange={(event) => setStyle(event.target.value)}><option value="">全部风格</option><option>电影感</option><option>自然系</option><option>高级简约</option></select></section><div className="mt-6 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">{templates.data?.items.map((template) => <TemplateCard key={template.id} template={template} onFavorite={() => favorite.mutate(template)} />)}</div></main>;
}
