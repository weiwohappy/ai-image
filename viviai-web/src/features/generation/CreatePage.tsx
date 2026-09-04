'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, ImagePlus, LoaderCircle, SlidersHorizontal, Sparkles, WandSparkles } from 'lucide-react';
import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { estimateCredits } from '@/src/lib/pricing';
import { api, ApiError } from '@/src/services/api';
import { queryKeys } from '@/src/services/queryKeys';
import { useSessionStore } from '@/src/stores/sessionStore';
import type { GenerationInput, GenerationTask } from '@/src/types/domain';
import { CreditEstimator } from './CreditEstimator';
import { GenerationCard } from './GenerationCard';
import { ModelParameterPanel } from './ModelParameterPanel';
import { PromptComposer } from './PromptComposer';
import { useGenerationTasks } from './useGenerationTasks';

export function CreatePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [error, setError] = useState('');
  const [showPaywall, setShowPaywall] = useState(false);
  const draft = useSessionStore((state) => state.generationDraft);
  const updateDraft = useSessionStore((state) => state.updateGenerationDraft);
  const me = useQuery({ queryKey: queryKeys.me, queryFn: api.getMe });
  const models = useQuery({ queryKey: queryKeys.models, queryFn: api.listModels });
  const { tasks, assets, cancel, retry } = useGenerationTasks();
  const estimated = estimateCredits({ modelId: draft.modelId, resolution: draft.resolution, quality: draft.quality, count: draft.count });

  const createTask = useMutation<GenerationTask, ApiError, GenerationInput>({
    mutationFn: (input) => api.createGenerationTask(input),
    onSuccess: (task) => {
      setError('');
      queryClient.setQueryData<GenerationTask[]>(queryKeys.tasks, (current = []) => [task, ...current.filter((item) => item.id !== task.id)]);
      queryClient.invalidateQueries({ queryKey: queryKeys.me });
    },
    onError: (failure) => {
      const apiError = failure as ApiError;
      setError(apiError.message || '创建任务失败。');
      setShowPaywall(apiError.code === 'INSUFFICIENT_CREDITS');
    },
  });

  function submit() {
    if (!draft.prompt.trim()) return;
    if (!me.data) {
      navigate('/login?redirect=%2Fcreate');
      return;
    }
    createTask.mutate({ ...draft, source: 'generation' });
  }

  const recentTasks = (tasks.data ?? []).slice(0, 6);
  const recentAssets = (assets.data ?? []).slice(0, 3);

  return (
    <main className="mx-auto w-full max-w-[1540px] p-4 md:p-6 xl:p-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div><h1 className="text-3xl font-semibold tracking-[-.045em] text-foreground md:text-4xl">图片生成</h1><p className="mt-2 text-base text-muted-foreground">描述画面，或从一张参考图开始。</p></div>
        <NavLink to="/remix" className="flex items-center gap-2 rounded-full border border-violet-400/25 bg-violet-400/10 px-4 py-2 text-sm text-violet-200 hover:border-violet-300/50"><WandSparkles className="size-4" />浏览爆款模板</NavLink>
      </div>

      <div className="grid min-h-[calc(100vh-10rem)] gap-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(340px,.7fr)]">
        <section className="relative overflow-hidden rounded-[28px] border border-border bg-card p-4 md:p-6">
          <div className="absolute inset-y-6 left-0 w-1 rounded-r-full bg-primary shadow-[0_0_28px_rgba(216,255,82,.38)]" />
          <div className="flex items-center justify-between gap-3"><div className="flex items-center gap-3"><span className="grid size-10 place-items-center rounded-2xl bg-primary/10 text-primary"><Sparkles className="size-5" /></span><div><h2 className="text-lg font-semibold">创作画布</h2><p className="text-xs text-muted-foreground">任务实时更新 · 结果自动保存</p></div></div><span className="rounded-full bg-secondary px-3 py-1.5 text-xs text-muted-foreground">{recentTasks.length} 个近期任务</span></div>
          <div className="mt-6 grid gap-3 md:grid-cols-[74px_1fr]">
            <aside className="hidden flex-col gap-3 md:flex" aria-label="参考图轨道"><button type="button" className="grid aspect-square place-items-center rounded-2xl border border-dashed border-border bg-background text-muted-foreground" aria-label="添加参考图"><ImagePlus className="size-5" /></button>{recentAssets.map((asset) => <img key={asset.id} src={asset.thumbnailUrl} alt="" className="aspect-square rounded-2xl object-cover opacity-80" />)}</aside>
            {recentTasks.length ? <div className="grid content-start gap-3 sm:grid-cols-2">{recentTasks.map((task) => <GenerationCard key={task.id} task={task} assets={assets.data ?? []} onCancel={() => cancel.mutate(task.id)} onRetry={() => retry.mutate(task.id)} />)}</div> : <div className="grid min-h-[440px] place-items-center rounded-[22px] border border-dashed border-border bg-background/45 p-8 text-center"><div><span className="mx-auto grid size-14 place-items-center rounded-2xl bg-primary/10 text-primary"><Sparkles /></span><h3 className="mt-5 text-xl font-semibold">从一句描述开始</h3><p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-muted-foreground">输入产品、场景、光线和构图要求。生成任务会在这里展示进度与结果。</p></div></div>}
          </div>
        </section>

        <aside className="flex min-h-[620px] flex-col rounded-[28px] border border-border bg-card p-5 md:p-6">
          <div className="flex items-center justify-between"><div><h2 className="text-lg font-semibold">生成设置</h2><p className="mt-1 text-xs text-muted-foreground">参数变化会实时计算积分</p></div><Button type="button" variant="ghost" size="icon" aria-label="打开高级设置" className="rounded-full"><SlidersHorizontal /></Button></div>
          <div className="mt-6 flex-1"><PromptComposer prompt={draft.prompt} onPromptChange={(prompt) => updateDraft({ prompt })} assets={assets.data ?? []} referenceAssetId={draft.referenceAssetId} onReferenceChange={(referenceAssetId) => updateDraft({ referenceAssetId })} /><ModelParameterPanel models={models.data ?? []} draft={draft} onChange={updateDraft} /><CreditEstimator credits={estimated} available={me.data?.credits} /></div>
          {error && <div role="alert" className="mt-4 rounded-xl border border-destructive/30 bg-destructive/8 p-3 text-sm text-destructive">{error}{showPaywall && <NavLink to="/pricing" className="ml-2 font-semibold underline">查看套餐</NavLink>}</div>}
          <Button type="button" size="lg" className="mt-5 h-12 w-full rounded-2xl text-sm font-bold" disabled={!draft.prompt.trim() || createTask.isPending || models.isPending} onClick={submit}>{createTask.isPending ? <><LoaderCircle className="animate-spin" />正在提交</> : <>开始生成 <ArrowUp /></>}</Button>
          <p className="mt-3 text-center text-xs text-muted-foreground">提交后进入任务队列，失败自动退回积分</p>
        </aside>
      </div>
    </main>
  );
}
