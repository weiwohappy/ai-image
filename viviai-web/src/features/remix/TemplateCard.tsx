'use client';

import { ArrowUpRight, Heart } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import type { ViralTemplate } from '@/src/types/domain';

export function TemplateCard({ template, onFavorite }: { template: ViralTemplate; onFavorite: () => void }) {
  return <article className="group overflow-hidden rounded-[22px] border border-border bg-card transition hover:-translate-y-0.5 hover:border-violet-300/30"><div className="relative"><img src={template.coverUrl} alt={template.title} className="aspect-[4/5] w-full object-cover" /><span className="absolute left-3 top-3 rounded-full bg-black/55 px-2.5 py-1 text-xs text-white backdrop-blur">{template.popularityLabel}</span><Button type="button" size="icon-sm" variant="secondary" className="absolute right-3 top-3 rounded-full" aria-label={`${template.favorite ? '取消收藏' : '收藏'}${template.title}`} onClick={onFavorite}><Heart className={template.favorite ? 'fill-primary text-primary' : ''} /></Button></div><div className="p-4"><div className="flex items-start justify-between gap-3"><div><h2 className="font-semibold">{template.title}</h2><p className="mt-1 text-xs text-muted-foreground">{template.platform} · {template.industry} · {template.remixCount} 次复刻</p></div><NavLink to={`/remix/${template.id}`} aria-label={`查看${template.title}`} className="grid size-9 shrink-0 place-items-center rounded-full bg-violet-400/10 text-violet-200 transition group-hover:bg-violet-400 group-hover:text-white"><ArrowUpRight className="size-4" /></NavLink></div><div className="mt-3 flex flex-wrap gap-1.5">{template.tags.map((tag) => <span key={tag} className="rounded-full bg-secondary px-2.5 py-1 text-xs text-muted-foreground">{tag}</span>)}</div></div></article>;
}
