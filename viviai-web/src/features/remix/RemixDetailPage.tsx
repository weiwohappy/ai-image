'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Aperture, Lightbulb, Palette, ScanLine } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { api } from '@/src/services/api';
import { queryKeys } from '@/src/services/queryKeys';
import { RemixWorkbench } from './RemixWorkbench';

export function RemixDetailPage() {
  const { templateId = '' } = useParams();
  const template = useQuery({ queryKey: [...queryKeys.templates, templateId], queryFn: () => api.getTemplate(templateId) });
  if (!template.data) return <main className="p-8"><div className="h-[70vh] animate-pulse rounded-[28px] bg-card" /></main>;
  const item = template.data;
  return <main className="mx-auto w-full max-w-[1480px] p-4 md:p-6 xl:p-8"><Link to="/remix" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" />返回爆款库</Link><div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(390px,.65fr)]"><section className="overflow-hidden rounded-[28px] border border-border bg-card"><div className="grid gap-0 md:grid-cols-[1.05fr_.95fr]"><img src={item.coverUrl} alt={item.title} className="h-full min-h-[420px] w-full object-cover" /><div className="p-6 md:p-8"><p className="text-sm font-medium text-violet-300">{item.popularityLabel} · {item.platform}</p><h1 className="mt-2 text-3xl font-semibold tracking-[-.04em]">{item.title}</h1><p className="mt-3 text-sm text-muted-foreground">已有 {item.remixCount} 次改编 · 推荐 {item.recommendedRatio}</p><h2 className="mt-8 text-sm font-semibold">AI 视觉拆解</h2><div className="mt-3 space-y-3"><Analysis icon={<ScanLine />} title="构图" text={item.analysis.composition} /><Analysis icon={<Palette />} title="色彩" text={item.analysis.palette.join(' · ')} /><Analysis icon={<Lightbulb />} title="光线" text={item.analysis.lighting} /><Analysis icon={<Aperture />} title="镜头" text={item.analysis.camera} /></div><div className="mt-5 rounded-xl border border-amber-300/15 bg-amber-300/5 p-3"><p className="text-xs font-medium text-amber-200">自动规避</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{item.analysis.avoid.join('、')}</p></div></div></div></section><RemixWorkbench templateId={templateId} /></div></main>;
}

function Analysis({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) { return <div className="flex gap-3 rounded-xl bg-background p-3 text-sm"><span className="mt-0.5 text-violet-300 [&_svg]:size-4">{icon}</span><div><strong>{title}</strong><p className="mt-1 leading-5 text-muted-foreground">{text}</p></div></div>; }
