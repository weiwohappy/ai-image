'use client';

import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Clock3, Layers3, ListTodo, XCircle } from 'lucide-react';
import { api } from '@/src/services/api';
import { queryKeys } from '@/src/services/queryKeys';
import { GenerationCard } from '@/src/features/generation/GenerationCard';

const batchStatusLabel = { queued: '批次排队中', processing: '批次处理中', succeeded: '批次完成', partial: '批次部分成功', failed: '批次失败', cancelled: '批次已取消' } as const;

export function TasksPage() {
  const batches = useQuery({ queryKey: queryKeys.batches, queryFn: api.listBatches, refetchInterval: (query) => query.state.data?.some((batch) => batch.status === 'processing') ? 600 : false });
  const tasks = useQuery({ queryKey: queryKeys.tasks, queryFn: api.listGenerationTasks, refetchInterval: (query) => query.state.data?.some((task) => task.status === 'queued' || task.status === 'processing') ? 600 : false });
  const assets = useQuery({ queryKey: queryKeys.assets, queryFn: () => api.listAssets() });
  return <main className="mx-auto w-full max-w-[1500px] p-4 md:p-6 xl:p-8"><header><p className="flex items-center gap-2 text-sm font-medium text-primary"><ListTodo className="size-4" />TASK CENTER</p><h1 className="mt-2 text-3xl font-semibold tracking-[-.04em] md:text-4xl">任务中心</h1><p className="mt-2 text-base text-muted-foreground">单次生成与批量工作流的统一进度视图。</p></header><section className="mt-7"><h2 className="text-lg font-semibold">批量任务</h2>{batches.data?.length ? <div className="mt-3 grid gap-3">{batches.data.map((batch) => <article key={batch.id} className="rounded-[22px] border border-border bg-card p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-3"><span className="grid size-10 place-items-center rounded-xl bg-primary/10 text-primary"><Layers3 /></span><div><h3 className="font-semibold">{batch.workflowName}</h3><p className="mt-1 text-xs text-muted-foreground">{batch.total} 个任务 · 预计 {batch.estimatedCredits} 积分</p></div></div><span className={`rounded-full px-3 py-1 text-xs ${batch.status === 'succeeded' ? 'bg-primary/10 text-primary' : batch.status === 'failed' ? 'bg-destructive/10 text-destructive' : 'bg-amber-300/10 text-amber-200'}`}>{batchStatusLabel[batch.status]}</span></div><div className="mt-4 grid grid-cols-3 gap-2 text-sm"><Metric icon={<CheckCircle2 />} label="已完成" value={batch.completed} /><Metric icon={<Clock3 />} label="处理中" value={batch.processing} /><Metric icon={<XCircle />} label="失败" value={batch.failed} /></div></article>)}</div> : <div className="mt-3 rounded-2xl border border-dashed border-border p-6 text-sm text-muted-foreground">还没有批量任务。</div>}</section><section className="mt-8"><h2 className="text-lg font-semibold">单次任务</h2><div className="mt-3 grid gap-4 md:grid-cols-2 xl:grid-cols-3">{tasks.data?.map((task) => <GenerationCard key={task.id} task={task} assets={assets.data ?? []} />)}</div></section></main>;
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) { return <div className="rounded-xl bg-background p-3"><span className="flex items-center gap-2 text-xs text-muted-foreground"><span className="[&_svg]:size-4">{icon}</span>{label}</span><strong className="mt-2 block text-xl">{value}</strong></div>; }
