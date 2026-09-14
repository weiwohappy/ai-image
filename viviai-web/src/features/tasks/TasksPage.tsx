'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Clock3, Layers3, ListTodo, RefreshCw, XCircle } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { GenerationCard } from '@/src/features/generation/GenerationCard';
import { BatchDetailDialog, batchStatusLabel } from '@/src/features/workflows/BatchDetailDialog';
import { WorkflowQuoteDialog } from '@/src/features/workflows/WorkflowQuoteDialog';
import { api } from '@/src/services/api';
import { queryKeys } from '@/src/services/queryKeys';
import type { WorkflowRun, WorkflowRunQuote } from '@/src/types/domain';

const TERMINAL: WorkflowRun['status'][] = ['succeeded', 'partial', 'failed', 'cancelled'];

export function TasksPage() {
  const queryClient = useQueryClient();
  const [detail, setDetail] = useState<WorkflowRun>();
  const [error, setError] = useState('');
  const [retryTarget, setRetryTarget] = useState<WorkflowRun>();
  const [quote, setQuote] = useState<WorkflowRunQuote>();
  const [quotedFingerprint, setQuotedFingerprint] = useState('');
  const [quotedRunId, setQuotedRunId] = useState('');
  const idempotencyKey = useRef<string | undefined>(undefined);

  const runs = useQuery({
    queryKey: queryKeys.workflowRuns,
    queryFn: api.listWorkflowRuns,
    // Only poll while something is still moving.
    refetchInterval: (query) => (query.state.data?.some((run) => !TERMINAL.includes(run.status)) ? 1500 : false),
  });
  const tasks = useQuery({ queryKey: queryKeys.tasks, queryFn: api.listGenerationTasks, refetchInterval: (query) => query.state.data?.some((task) => task.status === 'queued' || task.status === 'processing') ? 600 : false });
  const assets = useQuery({ queryKey: queryKeys.assets, queryFn: () => api.listAssets() });

  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.workflowRuns });
  const cancel = useMutation({
    mutationFn: (runId: string) => api.cancelWorkflowRun(runId),
    onSuccess: () => { setError(''); refresh(); },
    onError: (failure) => setError(failure instanceof Error ? failure.message : '取消失败，请稍后重试。'),
  });
  const retryQuote = useMutation({
    mutationFn: (runId: string) => api.quoteWorkflowRun({ retryRunId: runId }),
    onSuccess: (created) => { setQuote(created); setError(''); },
    onError: (failure) => setError(failure instanceof Error ? failure.message : '获取重试报价失败。'),
  });
  const retry = useMutation({
    mutationFn: (input: { runId: string; quoteId: string }) => api.retryWorkflowRun(input.runId, input.quoteId, idempotencyKey.current!),
    onSuccess: () => { setRetryTarget(undefined); setQuote(undefined); setError(''); refresh(); queryClient.invalidateQueries({ queryKey: queryKeys.tasks }); },
    onError: (failure) => setError(failure instanceof Error ? failure.message : '重试失败，请稍后重试。'),
  });

  const fingerprint = quote ? JSON.stringify({ retryRunId: quotedRunId }) : '';
  const detailRun = detail ? runs.data?.find((run) => run.id === detail.id) ?? detail : undefined;

  function openRetry(run: WorkflowRun) {
    idempotencyKey.current = crypto.randomUUID();
    setRetryTarget(run);
    setQuotedRunId(run.id);
    setQuotedFingerprint(JSON.stringify({ retryRunId: run.id }));
    setQuote(undefined);
    setError('');
    retryQuote.mutate(run.id);
  }

  return (
    <main className="mx-auto w-full max-w-[1500px] p-4 md:p-6 xl:p-8">
      <header>
        <p className="flex items-center gap-2 text-sm font-medium text-primary"><ListTodo className="size-4" />TASK CENTER</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-[-.04em] md:text-4xl">任务中心</h1>
        <p className="mt-2 text-base text-muted-foreground">单次生成与批量工作流的统一进度视图。</p>
      </header>
      {error && <p role="alert" className="mt-5 rounded-xl bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
      <section className="mt-7">
        <h2 className="text-lg font-semibold">批量任务</h2>
        {runs.data?.length ? (
          <div className="mt-3 grid gap-3">
            {runs.data.map((run) => (
              <article key={run.id} className="rounded-[22px] border border-border bg-card p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span className="grid size-10 place-items-center rounded-xl bg-primary/10 text-primary"><Layers3 /></span>
                    <div>
                      <h3 className="font-semibold">{run.workflowName}</h3>
                      <p className="mt-1 text-xs text-muted-foreground">{run.totalCount} 个任务 · 已扣 {run.chargedCredits} / 预计 {run.estimatedCredits} 积分</p>
                    </div>
                  </div>
                  <span className={`rounded-full px-3 py-1 text-xs ${run.status === 'succeeded' ? 'bg-primary/10 text-primary' : run.status === 'failed' ? 'bg-destructive/10 text-destructive' : 'bg-amber-300/10 text-amber-200'}`}>{batchStatusLabel[run.status]}</span>
                </div>
                <div className="mt-4 grid grid-cols-3 gap-2 text-sm">
                  <Metric icon={<CheckCircle2 />} label="已完成" value={run.succeededCount} />
                  <Metric icon={<Clock3 />} label="处理中" value={run.totalCount - run.succeededCount - run.failedCount - run.cancelledCount} />
                  <Metric icon={<XCircle />} label="失败" value={run.failedCount} />
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button type="button" size="sm" variant="outline" onClick={() => setDetail(run)}>查看详情</Button>
                  {!TERMINAL.includes(run.status) && (
                    <Button type="button" size="sm" variant="outline" disabled={cancel.isPending || run.cancelRequested} onClick={() => cancel.mutate(run.id)}>
                      {run.cancelRequested ? '正在取消…' : '取消剩余任务'}
                    </Button>
                  )}
                  {run.items.some((item) => item.status === 'failed' && item.retryable) && (
                    <Button type="button" size="sm" disabled={retryQuote.isPending} onClick={() => openRetry(run)}><RefreshCw />重试失败项</Button>
                  )}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="mt-3 rounded-2xl border border-dashed border-border p-6 text-sm text-muted-foreground">还没有批量任务。</div>
        )}
      </section>
      <section className="mt-8">
        <h2 className="text-lg font-semibold">单次任务</h2>
        <div className="mt-3 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {tasks.data?.map((task) => <GenerationCard key={task.id} task={task} assets={assets.data ?? []} />)}
        </div>
      </section>
      <BatchDetailDialog run={detailRun} assets={assets.data ?? []} onOpenChange={(open) => { if (!open) setDetail(undefined); }} />
      <WorkflowQuoteDialog
        open={Boolean(retryTarget)}
        onOpenChange={(open) => { if (!open) { setRetryTarget(undefined); setQuote(undefined); } }}
        quote={quote}
        loading={retryQuote.isPending}
        error={error}
        stale={quotedFingerprint !== fingerprint}
        submitting={retry.isPending}
        retrying
        onConfirm={() => { if (retryTarget && quote?.quoteId) retry.mutate({ runId: retryTarget.id, quoteId: quote.quoteId }); }}
        onReQuote={() => { if (retryTarget) { idempotencyKey.current = crypto.randomUUID(); setQuote(undefined); retryQuote.mutate(retryTarget.id); } }}
      />
    </main>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) { return <div className="rounded-xl bg-background p-3"><span className="flex items-center gap-2 text-xs text-muted-foreground"><span className="[&_svg]:size-4">{icon}</span>{label}</span><strong className="mt-2 block text-xl">{value}</strong></div>; }
