'use client';

import { Heart, WandSparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { Inspiration } from '@/src/types/domain';

export function InspirationCard({ item, onLike, onRemix }: { item: Inspiration; onLike: () => void; onRemix: () => void }) {
  return <article className="group relative mb-4 break-inside-avoid overflow-hidden rounded-[22px] border border-border bg-card"><img src={item.imageUrl} alt={item.title} className="w-full object-cover" /><div className="absolute inset-x-0 bottom-0 translate-y-3 bg-gradient-to-t from-black/90 via-black/55 to-transparent p-4 pt-20 opacity-0 transition duration-200 group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100"><h2 className="font-semibold text-white">{item.title}</h2><p className="mt-1 text-xs text-white/65">{item.creator} · {item.category}</p><div className="mt-3 flex gap-2"><Button type="button" size="sm" className="flex-1 rounded-full" onClick={onRemix}><WandSparkles />复刻这张</Button><Button type="button" size="sm" variant="secondary" className="rounded-full" aria-label={`${item.liked ? '取消点赞' : '点赞'}${item.title}`} onClick={onLike}><Heart className={item.liked ? 'fill-primary text-primary' : ''} />{item.likes}</Button></div></div></article>;
}
