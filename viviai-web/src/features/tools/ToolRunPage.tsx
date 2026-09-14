'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowUp, History, LoaderCircle, Sparkles } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { Link, NavLink, useParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { AssetPicker } from '@/src/features/assets/AssetPicker';
import { GenerationCard } from '@/src/features/generation/GenerationCard';
import { api } from '@/src/services/api';
import { queryKeys } from '@/src/services/queryKeys';
import type { ToolQuoteInput } from '@/src/types/domain';
import { ToolQuoteDialog } from './ToolQuoteDialog';
import { ToolSchemaForm } from './ToolSchemaForm';

export function ToolRunPage() {
  const { toolId = '' } = useParams();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [createdTaskId, setCreatedTaskId] = useState<string>();
  const [error, setError] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [quotedFingerprint, setQuotedFingerprint] = useState('');
  const idempotencyKey = useRef<string | undefined>(undefined);
  const tools = useQuery({ queryKey: queryKeys.tools, queryFn: api.listTools });
  const tasks = useQuery({ queryKey: queryKeys.tasks, queryFn: api.listGenerationTasks, refetchInterval: (query) => query.state.data?.some((task) => task.status === 'queued' || task.status === 'processing') ? 500 : false });
  const me = useQuery({ queryKey: queryKeys.me, queryFn: api.getMe });
  const currentTask = tasks.data?.find((task) => task.id === createdTaskId);
  const assets = useQuery({ queryKey: queryKeys.assets, queryFn: () => api.listAssets(), refetchInterval: currentTask?.status === 'queued' || currentTask?.status === 'processing' ? 500 : false });
  const tool = tools.data?.find((item) => item.id === toolId);
  const quoteInput = useMemo<ToolQuoteInput | undefined>(() => tool ? { toolId: tool.id, toolVersion: tool.version, assetIds: selected, values, modelId: tool.defaults.modelId, resolution: tool.defaults.resolution, ratio: tool.defaults.ratio, count: tool.defaults.count } : undefined, [tool, selected, values]);
  const quoteFingerprint = quoteInput ? JSON.stringify(quoteInput) : '';
  const createQuote = useMutation({
    mutationFn: () => api.createToolRunQuote(quoteInput!),
    onSuccess: () => { setQuotedFingerprint(quoteFingerprint); setError(''); },
    onError: (failure) => setError(failure instanceof Error ? failure.message : '获取报价失败。'),
  });
  const run = useMutation({
    mutationFn: (quoteId: string) => api.runTool(quoteId, idempotencyKey.current!),
    onSuccess: (task) => { setCreatedTaskId(task.id); setDialogOpen(false); setError(''); queryClient.setQueryData(queryKeys.tasks, (current: typeof tasks.data = []) => [task, ...(current ?? []).filter((item) => item.id !== task.id)]); },
    onError: (failure) => setError(failure instanceof Error ? failure.message : '任务创建失败。'),
  });
  if (tools.isPending) return <main className="p-8"><div className="h-[70vh] animate-pulse rounded-[28px] bg-card" /></main>;
  if (!tool) return <main className="p-8"><h1 className="text-2xl font-semibold">工具不存在</h1><Link to="/tools" className="mt-4 inline-block text-primary">返回工具中心</Link></main>;
  const valid = selected.length > 0 && selected.length <= tool.maxAssets && tool.fields.every((field) => !field.required || values[field.id]);
  const history = tasks.data?.filter((task) => task.toolId === toolId) ?? [];
  const openQuote = () => { idempotencyKey.current = crypto.randomUUID(); setQuotedFingerprint(''); setError(''); setDialogOpen(true); createQuote.mutate(); };
  const reQuote = () => { idempotencyKey.current = crypto.randomUUID(); setQuotedFingerprint(''); setError(''); createQuote.mutate(); };
  return <main className="mx-auto w-full max-w-[1460px] p-4 md:p-6 xl:p-8"><Link to="/tools" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" />返回工具中心</Link><div className="mt-5 grid gap-5 xl:grid-cols-[minmax(360px,.68fr)_minmax(0,1.32fr)]"><aside className="rounded-[28px] border border-border bg-card p-5 md:p-6"><div className="flex gap-4"><img src={tool.coverUrl} alt="" className="size-20 rounded-2xl object-cover" /><div><p className="text-xs text-primary">{tool.category}</p><h1 className="mt-1 text-2xl font-semibold">{tool.name}</h1><p className="mt-2 text-sm leading-5 text-muted-foreground">{tool.description}</p></div></div><div className="mt-6"><AssetPicker selected={selected} onChange={setSelected} max={tool.maxAssets} label={`选择${tool.assetLabel}`} /></div><div className="my-6 h-px bg-border" /><ToolSchemaForm fields={tool.fields} values={values} onChange={(id, value) => setValues((current) => ({ ...current, [id]: value }))} />{error && <p role="alert" className="mt-4 rounded-xl bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}<Button type="button" className="mt-6 h-12 w-full rounded-2xl font-bold" disabled={!valid || createQuote.isPending} onClick={openQuote}>{createQuote.isPending ? <><LoaderCircle className="animate-spin" />正在报价</> : <>开始生成 <ArrowUp /></>}</Button></aside><section className="rounded-[28px] border border-border bg-card p-5 md:p-6"><div className="flex items-center justify-between"><div><h2 className="text-xl font-semibold">处理结果</h2><p className="mt-1 text-sm text-muted-foreground">当前结果与历史任务</p></div><span className="flex items-center gap-2 rounded-full bg-secondary px-3 py-1.5 text-xs text-muted-foreground"><History className="size-4" />{history.length} 条历史</span></div>{currentTask ? <div className="mt-5 max-w-lg"><GenerationCard task={currentTask} assets={assets.data ?? []} /></div> : history.length ? <div className="mt-5 grid gap-4 md:grid-cols-2">{history.map((task) => <GenerationCard key={task.id} task={task} assets={assets.data ?? []} />)}</div> : <div className="mt-5 grid min-h-[480px] place-items-center rounded-[22px] border border-dashed border-border bg-background/40 text-center"><div><span className="mx-auto grid size-14 place-items-center rounded-2xl bg-primary/10 text-primary"><Sparkles /></span><h3 className="mt-4 text-lg font-semibold">处理结果将在这里出现</h3><p className="mt-2 text-sm text-muted-foreground">选择素材并完成左侧必填项。</p></div></div>}<NavLink to="/assets" className="mt-4 inline-block text-sm text-primary hover:underline">前往资产库</NavLink></section></div><ToolQuoteDialog open={dialogOpen} onOpenChange={setDialogOpen} tool={tool} quote={createQuote.data} loading={createQuote.isPending} error={error} stale={quotedFingerprint !== '' && quoteFingerprint !== quotedFingerprint} submitting={run.isPending} balance={me.data?.credits} onConfirm={() => createQuote.data && run.mutate(createQuote.data.quoteId)} onReQuote={reQuote} /></main>;
}
