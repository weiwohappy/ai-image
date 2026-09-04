'use client';

import { useQuery } from '@tanstack/react-query';
import { Search, Wrench } from 'lucide-react';
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { api } from '@/src/services/api';
import { queryKeys } from '@/src/services/queryKeys';
import { ToolCard } from './ToolCard';

export function ToolsPage() {
  const [query, setQuery] = useState('');
  const tools = useQuery({ queryKey: queryKeys.tools, queryFn: api.listTools });
  const filtered = tools.data?.filter((tool) => `${tool.name}${tool.description}${tool.category}`.includes(query)) ?? [];
  return <main className="mx-auto w-full max-w-[1500px] p-4 md:p-6 xl:p-8"><header className="flex flex-wrap items-end justify-between gap-5"><div><p className="flex items-center gap-2 text-sm font-medium text-primary"><Wrench className="size-4" />AI TOOLKIT</p><h1 className="mt-2 text-3xl font-semibold tracking-[-.04em] md:text-4xl">工具中心</h1><p className="mt-2 text-base text-muted-foreground">把常用图片任务做成一键式工作流。</p></div><label className="relative w-full max-w-sm"><Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input aria-label="搜索工具" className="h-11 rounded-full bg-card pl-10" placeholder="搜索工具" value={query} onChange={(event) => setQuery(event.target.value)} /></label></header><div className="mt-7 grid gap-4 md:grid-cols-2 xl:grid-cols-3">{filtered.map((tool) => <ToolCard key={tool.id} tool={tool} />)}</div></main>;
}
