'use client';

import { useQuery } from '@tanstack/react-query';
import { Check, Crown, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { api } from '@/src/services/api';
import { queryKeys } from '@/src/services/queryKeys';
import type { Plan } from '@/src/types/domain';
import { CheckoutDialog } from './CheckoutDialog';

const cycles = [{ value: 'month', label: '月付' }, { value: 'quarter', label: '季付' }, { value: 'year', label: '年付' }] as const;

export function PricingPage() {
  const plans = useQuery({ queryKey: queryKeys.plans, queryFn: api.listPlans });
  const me = useQuery({ queryKey: queryKeys.me, queryFn: api.getMe });
  const [cycle, setCycle] = useState<Plan['cycle']>('month');
  const [selected, setSelected] = useState<Plan>();
  const visible = plans.data?.filter((plan) => plan.cycle === cycle) ?? [];
  const enterprise = plans.data?.find((plan) => plan.cycle === 'enterprise');
  return <main className="mx-auto w-full max-w-[1440px] p-4 md:p-6 xl:p-8"><header className="mx-auto max-w-3xl text-center"><p className="text-sm font-medium text-primary">PLANS & CREDITS</p><h1 className="mt-2 text-3xl font-semibold tracking-[-.045em] md:text-5xl">按创作规模选择套餐</h1><p className="mt-4 text-base leading-7 text-muted-foreground">积分用于模型调用；任务失败自动退回。前端演示支付不会真实扣款。</p><div className="mt-6 inline-flex rounded-full border border-border bg-card p-1">{cycles.map((item) => <button type="button" key={item.value} className={`rounded-full px-5 py-2 text-sm ${cycle === item.value ? 'bg-primary font-semibold text-primary-foreground' : 'text-muted-foreground'}`} onClick={() => setCycle(item.value)}>{item.label}</button>)}</div></header><div className="mt-9 grid gap-4 lg:grid-cols-3">{visible.map((plan, index) => <article key={plan.id} className={`relative rounded-[26px] border p-6 ${index === 1 ? 'border-primary/45 bg-primary/[.07] shadow-[0_0_35px_rgba(216,255,82,.07)]' : 'border-border bg-card'}`}>{index === 1 && <span className="absolute -top-3 left-6 rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground">性价比推荐</span>}<p className="text-sm text-muted-foreground">{plan.name}</p><div className="mt-4 flex items-end gap-2"><strong className="text-4xl">¥{plan.price}</strong>{plan.originalPrice && <del className="pb-1 text-sm text-muted-foreground">¥{plan.originalPrice}</del>}</div><p className="mt-4 text-2xl font-semibold text-primary">{plan.credits?.toLocaleString()} 创作积分</p><p className="mt-2 text-sm text-muted-foreground">并发 {plan.concurrency} · {plan.durationDays} 天</p><ul className="mt-6 space-y-3">{plan.features.slice(0, 5).map((feature) => <li key={feature} className="flex items-center gap-2 text-sm"><Check className="size-4 text-primary" />{feature}</li>)}</ul><Button type="button" variant={index === 1 ? 'default' : 'outline'} className="mt-7 h-11 w-full rounded-xl" disabled={me.data?.planId === plan.id} onClick={() => setSelected(plan)} aria-label={me.data?.planId === plan.id ? `当前套餐${plan.name}` : `购买${plan.name}`}>{me.data?.planId === plan.id ? '当前套餐' : `选择${plan.name}`}</Button></article>)}</div>{enterprise && <section className="mt-5 flex flex-wrap items-center justify-between gap-5 rounded-[26px] border border-border bg-card p-6"><div className="flex items-center gap-4"><span className="grid size-12 place-items-center rounded-2xl bg-violet-400/10 text-violet-300"><Crown /></span><div><h2 className="text-xl font-semibold">企业版</h2><p className="mt-1 text-sm text-muted-foreground">定制积分、并发、合同与团队支持</p></div></div><Button type="button" variant="outline" className="rounded-full"><ShieldCheck />联系商务</Button></section>}<CheckoutDialog plan={selected} open={Boolean(selected)} onOpenChange={(open) => !open && setSelected(undefined)} /></main>;
}
