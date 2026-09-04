'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, Coins, LoaderCircle, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { estimateCredits } from '@/src/lib/pricing';
import { api } from '@/src/services/api';
import { queryKeys } from '@/src/services/queryKeys';
import type { GenerationTask, ImageRatio, OutputCount, RemixStrength, Resolution } from '@/src/types/domain';
import { AssetPicker } from '@/src/features/assets/AssetPicker';

const strengths: Array<{ value: RemixStrength; label: string; hint: string }> = [
  { value: 'similar', label: '高度相似', hint: '保留更多视觉结构' },
  { value: 'balanced', label: '平衡复刻', hint: '结构与创新兼顾' },
  { value: 'creative', label: '创意发散', hint: '仅保留核心灵感' },
];

export function RemixWorkbench({ templateId }: { templateId: string }) {
  const queryClient = useQueryClient();
  const template = useQuery({ queryKey: [...queryKeys.templates, templateId], queryFn: () => api.getTemplate(templateId) });
  const [adaptation, setAdaptation] = useState('');
  const [strength, setStrength] = useState<RemixStrength>('balanced');
  const [subject, setSubject] = useState<string[]>([]);
  const [resolution, setResolution] = useState<Resolution>('1K');
  const [ratio, setRatio] = useState<ImageRatio>('1:1');
  const [count, setCount] = useState<OutputCount>(1);
  const [created, setCreated] = useState<GenerationTask>();
  const [error, setError] = useState('');
  const modelId = template.data?.recommendedModelId ?? 'nano-banana-2';
  const estimate = estimateCredits({ modelId, resolution, count });
  const create = useMutation({ mutationFn: () => {
    if (!template.data) throw new Error('模板仍在加载。');
    return api.createRemixTask({ templateId, templateVersion: template.data.version, adaptation, strength, modelId, resolution, ratio, count, subjectAssetId: subject[0] });
  }, onSuccess: (task) => { setCreated(task); setError(''); queryClient.invalidateQueries({ queryKey: queryKeys.tasks }); }, onError: (failure) => setError(failure instanceof Error ? failure.message : '创建复刻任务失败。') });
  if (template.isPending) return <div className="h-96 animate-pulse rounded-[28px] bg-card" />;
  if (!template.data) return <div className="rounded-2xl border border-destructive/30 p-6 text-destructive">模板不存在或已下架。</div>;
  return <section className="rounded-[28px] border border-border bg-card p-5 md:p-6"><h2 className="text-xl font-semibold">改编设置</h2><p className="mt-2 flex gap-2 text-xs leading-5 text-muted-foreground"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />系统会规避原图 Logo、文案、水印及可识别人物身份。</p><label htmlFor="remix-adaptation" className="mt-6 block text-sm font-medium">描述你要修改的内容</label><Textarea id="remix-adaptation" aria-label="描述你要修改的内容" className="mt-2 min-h-28 rounded-2xl bg-background p-3 text-base" placeholder="例如：替换为新款咖啡礼盒，使用棕金配色，右侧保留价格区……" value={adaptation} onChange={(event) => setAdaptation(event.target.value)} /><fieldset className="mt-5"><legend className="text-sm font-medium">复刻强度</legend><div className="mt-2 grid gap-2 sm:grid-cols-3">{strengths.map((item) => <label key={item.value} className={`rounded-xl border p-3 ${strength === item.value ? 'border-violet-300/50 bg-violet-400/10' : 'border-border bg-background'}`}><input type="radio" aria-label={item.label} name="strength" className="sr-only" value={item.value} checked={strength === item.value} onChange={() => setStrength(item.value)} /><strong className="block text-sm">{item.label}</strong><span className="mt-1 block text-xs text-muted-foreground">{item.hint}</span></label>)}</div></fieldset><div className="mt-5"><AssetPicker selected={subject} onChange={setSubject} label="主体素材（可选）" /></div><div className="mt-5 grid grid-cols-3 gap-2"><label className="rounded-xl border border-border bg-background p-2.5 text-xs text-muted-foreground">清晰度<select aria-label="复刻清晰度" className="mt-1 block w-full bg-transparent text-sm font-semibold text-foreground" value={resolution} onChange={(event) => setResolution(event.target.value as Resolution)}><option>1K</option><option>2K</option><option>4K</option></select></label><label className="rounded-xl border border-border bg-background p-2.5 text-xs text-muted-foreground">比例<select aria-label="复刻比例" className="mt-1 block w-full bg-transparent text-sm font-semibold text-foreground" value={ratio} onChange={(event) => setRatio(event.target.value as ImageRatio)}><option>1:1</option><option>3:4</option><option>4:3</option><option>16:9</option></select></label><label className="rounded-xl border border-border bg-background p-2.5 text-xs text-muted-foreground">张数<select aria-label="复刻张数" className="mt-1 block w-full bg-transparent text-sm font-semibold text-foreground" value={count} onChange={(event) => setCount(Number(event.target.value) as OutputCount)}><option value="1">1 张</option><option value="2">2 张</option><option value="4">4 张</option></select></label></div><div className="mt-4 flex items-center justify-between rounded-xl bg-primary/6 px-3 py-2.5 text-sm"><span className="flex items-center gap-2 text-muted-foreground"><Coins className="size-4 text-primary" />预计消耗</span><strong className="text-primary">{estimate} 积分</strong></div>{error && <p role="alert" className="mt-3 rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}{created && <p role="status" className="mt-3 rounded-xl bg-primary/10 px-3 py-2 text-sm text-primary">复刻任务已提交，正在排队。<NavLink className="ml-2 underline" to="/create">查看进度</NavLink></p>}<Button type="button" className="mt-5 h-12 w-full rounded-2xl font-bold" disabled={!adaptation.trim() || create.isPending} onClick={() => create.mutate()}>{create.isPending ? <><LoaderCircle className="animate-spin" />正在提交</> : <>开始复刻 <ArrowUp /></>}</Button></section>;
}
