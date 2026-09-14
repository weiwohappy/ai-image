'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, Coins, LoaderCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { AssetPicker } from '@/src/features/assets/AssetPicker';
import { GenerationCard } from '@/src/features/generation/GenerationCard';
import { useGenerationTasks } from '@/src/features/generation/useGenerationTasks';
import { estimateCredits } from '@/src/lib/pricing';
import { api } from '@/src/services/api';
import { createRemix } from '@/src/services/generationFlow';
import { queryKeys } from '@/src/services/queryKeys';
import { useSessionStore, type RemixDraft } from '@/src/stores/sessionStore';
import type { GenerationTask, ImageRatio, OutputCount, RemixStrength, Resolution } from '@/src/types/domain';
import { ReferenceImageInput } from './ReferenceImageInput';

const strengths: Array<{ value: RemixStrength; label: string; hint: string }> = [
  { value: 'similar', label: '相似构图', hint: '更多保留布局和光影' },
  { value: 'balanced', label: '平衡复刻', hint: '兼顾参考与新想法' },
  { value: 'creative', label: '创意改编', hint: '借鉴风格，自由发挥' },
];

export function RemixWorkbench({ templateId }: { templateId?: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const draftKey = templateId ?? 'upload';
  const template = useQuery({ queryKey: [...queryKeys.templates, templateId], queryFn: () => api.getTemplate(templateId!), enabled: Boolean(templateId) });
  const me = useQuery({ queryKey: queryKeys.me, queryFn: api.getMe });
  const models = useQuery({ queryKey: queryKeys.models, queryFn: api.listModels });
  const { tasks, assets, cancel } = useGenerationTasks();
  const storedDraft = useSessionStore((state) => state.remixDrafts[draftKey]);
  const updateDraft = useSessionStore((state) => state.updateRemixDraft);
  const pendingKey = useSessionStore((state) => state.pendingRemixTemplateId);
  const setPendingKey = useSessionStore((state) => state.setPendingRemixTemplateId);
  const draft: RemixDraft = storedDraft ?? { adaptation: '', strength: 'balanced', resolution: '1K', ratio: '1:1', count: 1 };
  const { adaptation, strength, subjectAssetId, resolution, ratio, count, reference, subject } = draft;
  const [referenceBusy, setReferenceBusy] = useState(false);
  const [subjectBusy, setSubjectBusy] = useState(false);
  const [error, setError] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [quoteCredits, setQuoteCredits] = useState<number>();
  const [useTemplate, setUseTemplate] = useState(Boolean(templateId));
  const selectedTemplate = useTemplate && !reference ? template.data : undefined;
  const hasReference = Boolean(reference || selectedTemplate);
  const model = models.data?.find((item) => !item.simulated) ?? models.data?.[0];
  const modelId = model?.id ?? 'nano-banana-2';
  const modelSpecs = model?.specs ?? [];
  const modelResolutions = modelSpecs.length ? [...new Set(modelSpecs.map((item) => item.resolution))] : (model?.resolutions ?? ['1K', '2K', '4K']);
  const modelRatios = modelSpecs.length ? [...new Set(modelSpecs.filter((item) => item.resolution === resolution).map((item) => item.ratio))] : (model?.ratios ?? ['1:1', '3:4', '4:3', '9:16', '16:9']);
  const canSubmit = hasReference && Boolean(adaptation.trim()) && !referenceBusy && !subjectBusy && !me.isPending && !models.isPending && Boolean(model);
  const selectedSpec = modelSpecs.find((spec) => spec.resolution === resolution && spec.ratio === ratio);
  const estimate = quoteCredits ?? (selectedSpec?.unitCredits !== undefined ? selectedSpec.unitCredits * count : model?.unitCredits !== undefined ? model.unitCredits * count : (() => { try { return estimateCredits({ modelId, resolution, count }); } catch { return 0; } })());
  const task = tasks.data?.find((item) => item.id === draft.lastTaskId);
  const create = useMutation({
    mutationFn: () => createRemix({
      referenceAssetId: reference?.id,
      templateId: selectedTemplate?.id,
      templateVersion: selectedTemplate?.version,
      adaptation, strength, modelId, resolution, ratio, count,
      subjectAssetId: subject?.id ?? subjectAssetId,
    }),
    onSuccess: ({ task: created, quote }) => {
      setPendingKey(undefined);
      setError('');
      setSubmitted(true);
      setQuoteCredits(quote.totalCredits);
      updateDraft(draftKey, { lastTaskId: created.id });
      queryClient.setQueryData<GenerationTask[]>(queryKeys.tasks, (current = []) => [created, ...current.filter((item) => item.id !== created.id)]);
      queryClient.invalidateQueries({ queryKey: queryKeys.me });
    },
    onError: (failure) => { setPendingKey(undefined); setError(failure instanceof Error ? failure.message : '创建复刻任务失败。'); },
  });
  useEffect(() => {
    if (template.data && !storedDraft?.initialized) updateDraft(draftKey, { ratio: template.data.recommendedRatio, initialized: true });
  }, [storedDraft?.initialized, template.data, draftKey, updateDraft]);
  useEffect(() => {
    if (!model || modelResolutions.includes(resolution)) return;
    const nextResolution = modelResolutions[0];
    const nextRatio = modelSpecs.find((item) => item.resolution === nextResolution)?.ratio ?? model.ratios[0];
    updateDraft(draftKey, { resolution: nextResolution, ...(nextRatio ? { ratio: nextRatio } : {}) });
  }, [model, modelResolutions, modelSpecs, resolution, draftKey, updateDraft]);
  useEffect(() => {
    if (pendingKey === draftKey && useSessionStore.getState().pendingRemixTemplateId === draftKey && me.data && canSubmit && !create.isPending) {
      setPendingKey(undefined);
      create.mutate();
    }
  }, [pendingKey, draftKey, me.data, canSubmit, create, setPendingKey]);
  useEffect(() => {
    if (task && task.status !== 'queued' && task.status !== 'processing') {
      queryClient.invalidateQueries({ queryKey: queryKeys.assets });
      queryClient.invalidateQueries({ queryKey: queryKeys.me });
    }
  }, [task?.id, task?.status, queryClient]);

  function submit() {
    if (!canSubmit) return;
    setSubmitted(false);
    setError('');
    setQuoteCredits(undefined);
    if (!me.data) {
      setPendingKey(draftKey);
      navigate(`/login?redirect=${encodeURIComponent(templateId ? `/remix/${templateId}` : '/remix')}`);
      return;
    }
    create.mutate();
  }

  return (
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,.8fr)]">
      <section className="min-w-0 rounded-[28px] border border-border bg-card p-5 md:p-6">
        <div className="mb-5 flex items-start justify-between gap-3"><div><h2 className="text-xl font-semibold">你的爆款参考图</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">上传你想借鉴的图片，参考它的构图、配色和氛围。</p></div><span className="shrink-0 rounded-full bg-violet-400/10 px-3 py-1.5 text-xs text-violet-200">必填 · 1 张</span></div>
        {selectedTemplate ? <div className="overflow-hidden rounded-2xl border border-border bg-background"><img src={selectedTemplate.coverUrl} alt="爆款参考图预览" className="h-[390px] w-full object-contain" /><div className="flex items-center justify-between p-3"><p className="text-sm">示例：{selectedTemplate.title}</p><Button variant="outline" onClick={() => setUseTemplate(false)}>上传自己的参考图</Button></div></div> : <ReferenceImageInput value={reference} onBusyChange={setReferenceBusy} onChange={(next) => { setUseTemplate(false); updateDraft(draftKey, { reference: next, referenceNeedsUpload: false }); }} />}
        {draft.referenceNeedsUpload && !reference && !selectedTemplate && <p role="status" className="mt-3 text-sm text-amber-200">你的复刻要求已保留，请重新上传参考图后继续。</p>}
        <div className="mt-5 border-t border-border pt-4"><h3 className="text-sm font-medium">怎样描述效果？</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">例如：保留参考图的俯拍构图、暖色光线和右侧留白，把主角换成我的咖啡礼盒，背景改成浅米色。</p></div>
        {template.isError && useTemplate && <p role="alert" className="mt-3 text-sm text-destructive">示例不可用，请上传自己的参考图。</p>}
      </section>

      <section className="min-w-0 rounded-[28px] border border-border bg-card p-5 md:p-6">
        <h2 className="text-xl font-semibold">复刻要求</h2>
        <label htmlFor="remix-adaptation" className="mt-5 block text-sm font-medium">描述希望保留和修改的内容 <span className="text-violet-300">*</span></label>
        <Textarea id="remix-adaptation" className="mt-2 min-h-32 rounded-2xl bg-background p-3 text-base" placeholder="保留哪些构图、色彩或光影？替换什么商品、人物、背景或文字？" value={adaptation} onChange={(event) => updateDraft(draftKey, { adaptation: event.target.value })} />
        <fieldset className="mt-5"><legend className="text-sm font-medium">复刻强度</legend><div className="mt-2 grid gap-2 sm:grid-cols-3">{strengths.map((item) => <label key={item.value} className={`cursor-pointer rounded-xl border p-3 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-violet-300 ${strength === item.value ? 'border-violet-300/50 bg-violet-400/10' : 'border-border bg-background'}`}><input type="radio" aria-label={item.label} name="strength" className="sr-only" checked={strength === item.value} onChange={() => updateDraft(draftKey, { strength: item.value })} /><strong className="block text-sm">{item.label}</strong><span className="mt-1 block text-xs leading-5 text-muted-foreground">{item.hint}</span></label>)}</div></fieldset>
        <details className="mt-5 rounded-2xl border border-border bg-background/40 p-4">
          <summary className="cursor-pointer text-sm font-medium">加入我的商品 / 主体素材 <span className="font-normal text-muted-foreground">（可选）</span>{(subject || subjectAssetId) && <span className="ml-2 text-primary">已选择</span>}</summary>
          <p className="mb-3 mt-2 text-xs leading-5 text-muted-foreground">用于替换参考图里的主体，例如你的商品实拍图。</p>
          <ReferenceImageInput label="主体素材" compact value={subject} onBusyChange={setSubjectBusy} onChange={(next) => updateDraft(draftKey, { subject: next, subjectAssetId: undefined, subjectNeedsUpload: false })} />
          {draft.subjectNeedsUpload && !subject && <p className="mt-2 text-xs text-amber-200">上次的主体素材需要重新上传，也可以不添加主体素材继续。</p>}
          {!subject && <div className="mt-4"><AssetPicker selected={subjectAssetId ? [subjectAssetId] : []} onChange={(selected) => updateDraft(draftKey, { subjectAssetId: selected[0], subjectNeedsUpload: false })} label="或从我的资产选择" /></div>}
        </details>
        <div className="mt-5 flex items-center justify-between text-sm"><span className="text-muted-foreground">生成模型</span><span>{model?.name ?? 'Nano Banana 2'}</span></div>
        <div className="mt-3 grid grid-cols-3 gap-2">
          <label className="rounded-xl border border-border bg-background p-2.5 text-xs text-muted-foreground">清晰度<select aria-label="复刻清晰度" className="mt-1 block w-full bg-transparent text-sm font-semibold text-foreground" value={resolution} onChange={(event) => { const nextResolution = event.target.value as Resolution; const nextRatio = modelSpecs.find((item) => item.resolution === nextResolution && item.ratio === ratio)?.ratio ?? modelSpecs.find((item) => item.resolution === nextResolution)?.ratio; updateDraft(draftKey, { resolution: nextResolution, ...(nextRatio ? { ratio: nextRatio } : {}) }); }}>{modelResolutions.map((value) => <option key={value}>{value}</option>)}</select></label>
          <label className="rounded-xl border border-border bg-background p-2.5 text-xs text-muted-foreground">比例<select aria-label="复刻比例" className="mt-1 block w-full bg-transparent text-sm font-semibold text-foreground" value={ratio} onChange={(event) => updateDraft(draftKey, { ratio: event.target.value as ImageRatio })}>{modelRatios.map((value) => { const spec = modelSpecs.find((candidate) => candidate.resolution === resolution && candidate.ratio === value); return <option key={value} value={value}>{spec ? `${value} · ${spec.width}×${spec.height}` : value}</option>; })}</select></label>
          <label className="rounded-xl border border-border bg-background p-2.5 text-xs text-muted-foreground">张数<select aria-label="复刻张数" className="mt-1 block w-full bg-transparent text-sm font-semibold text-foreground" value={count} onChange={(event) => updateDraft(draftKey, { count: Number(event.target.value) as OutputCount })}><option value="1">1 张</option><option value="2">2 张</option><option value="4">4 张</option></select></label>
        </div>
        <div className="mt-4 flex items-center justify-between rounded-xl bg-primary/6 px-3 py-2.5 text-sm"><span className="flex items-center gap-2 text-muted-foreground"><Coins className="size-4 text-primary" />预计消耗</span><strong className="text-primary">{estimate} 积分</strong></div>
        {error && <p role="alert" className="mt-3 rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
        {!models.isPending && !model && <p role="alert" className="mt-3 rounded-xl border border-amber-300/20 bg-amber-300/8 px-3 py-2 text-sm text-amber-200">当前没有可用图片模型，请先配置模型和分辨率积分。</p>}
        <Button type="button" className="mt-5 h-12 w-full rounded-2xl font-bold" disabled={!canSubmit || create.isPending} onClick={submit}>{create.isPending ? <><LoaderCircle className="animate-spin" />正在提交</> : <>开始复刻 <ArrowUp /></>}</Button>
        <p className="mt-3 text-center text-xs text-muted-foreground">{!hasReference ? '先上传参考图，再填写复刻要求' : '参考图 + 复刻要求，一起用于生成新图'}</p>
        {submitted && <p role="status" className="mt-3 text-sm text-primary">复刻任务已提交，进度和结果显示在下方。</p>}
      </section>
      {task && <section className="min-w-0 rounded-[28px] border border-border bg-card p-5 md:p-6 xl:col-span-2"><div className="mb-4 flex items-center justify-between"><h2 className="text-xl font-semibold">本次复刻结果</h2><NavLink className="text-sm text-violet-300 hover:underline" to="/assets">查看我的资产</NavLink></div><div className="max-w-xl"><GenerationCard task={task} assets={assets.data ?? []} onCancel={() => cancel.mutate(task.id)} /></div></section>}
    </div>
  );
}
