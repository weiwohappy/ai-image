'use client';

import { useParams } from 'react-router-dom';
import { RemixWorkbench } from './RemixWorkbench';

export function RemixPage() {
  const { templateId } = useParams();
  return <main className="mx-auto w-full max-w-[1540px] p-4 md:p-6 xl:p-8"><header className="mb-7"><h1 className="text-3xl font-semibold tracking-[-.045em] md:text-4xl">爆款复刻</h1><p className="mt-3 text-base leading-7 text-muted-foreground">上传你找到的爆款图，写下你的想法，生成属于你的新图片。</p><ol aria-label="复刻步骤" className="mt-5 flex flex-wrap gap-x-7 gap-y-2 text-sm text-muted-foreground">{['上传参考图', '描述复刻要求', '生成新图片'].map((step, index) => <li key={step} className="flex items-center gap-2"><span className="grid size-6 place-items-center rounded-full bg-violet-400/10 text-xs text-violet-200">{index + 1}</span>{step}</li>)}</ol></header><RemixWorkbench key={templateId ?? 'upload'} templateId={templateId} /></main>;
}
