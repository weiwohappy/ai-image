'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, LoaderCircle, QrCode } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api } from '@/src/services/api';
import { queryKeys } from '@/src/services/queryKeys';
import type { Order, Plan } from '@/src/types/domain';

export function CheckoutDialog({ plan, open, onOpenChange }: { plan?: Plan; open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const [channel, setChannel] = useState<Order['channel']>();
  const [completed, setCompleted] = useState(false);
  const purchase = useMutation({ mutationFn: async () => {
    if (!plan || !channel) throw new Error('请选择支付方式。');
    const order = await api.createOrder({ planId: plan.id, channel });
    await api.completeMockOrder(order.id);
    return plan;
  }, onSuccess: async () => { setCompleted(true); await Promise.all([queryClient.invalidateQueries({ queryKey: queryKeys.me }), queryClient.invalidateQueries({ queryKey: queryKeys.ledger }), queryClient.invalidateQueries({ queryKey: queryKeys.notifications })]); } });
  return <Dialog open={open} onOpenChange={(next) => { onOpenChange(next); if (!next) { setCompleted(false); setChannel(undefined); purchase.reset(); } }}><DialogContent className="max-w-md rounded-[26px] border border-border bg-card p-6"><DialogHeader><DialogTitle className="text-2xl">{completed ? `${plan?.name}已到账` : '确认套餐'}</DialogTitle><DialogDescription>{completed ? '权益已更新到当前演示账户。' : '这是前端 Mock 支付，不会产生真实扣款。'}</DialogDescription></DialogHeader>{completed ? <div className="py-6 text-center"><CheckCircle2 className="mx-auto size-14 text-primary" /><p className="mt-4 text-2xl font-semibold">{plan?.credits?.toLocaleString()} 积分</p><p className="mt-2 text-sm text-muted-foreground">并发额度 {plan?.concurrency} · 有效期 {plan?.durationDays} 天</p><Button type="button" className="mt-6 w-full" onClick={() => onOpenChange(false)}>完成</Button></div> : plan && <div><div className="mt-2 rounded-2xl border border-primary/15 bg-primary/6 p-4"><div className="flex items-end justify-between"><div><p className="text-sm text-muted-foreground">{plan.name}</p><p className="mt-2 text-3xl font-semibold">¥{plan.price}</p></div><div className="text-right text-sm"><strong className="text-primary">{plan.credits?.toLocaleString()} 积分</strong><p className="mt-1 text-xs text-muted-foreground">{plan.durationDays} 天</p></div></div></div><fieldset className="mt-5"><legend className="text-sm font-medium">支付方式</legend><div className="mt-2 grid grid-cols-2 gap-2">{([{ value: 'alipay', label: '支付宝' }, { value: 'wechat', label: '微信支付' }] as const).map((item) => <label key={item.value} className={`flex items-center gap-3 rounded-xl border p-3 ${channel === item.value ? 'border-primary bg-primary/8' : 'border-border bg-background'}`}><input type="radio" aria-label={item.label} name="channel" value={item.value} checked={channel === item.value} onChange={() => setChannel(item.value)} className="accent-[var(--primary)]" /><span className="text-sm font-medium">{item.label}</span></label>)}</div></fieldset><div className="mt-5 grid aspect-[3/1] place-items-center rounded-xl border border-dashed border-border bg-background"><span className="flex items-center gap-2 text-xs text-muted-foreground"><QrCode className="size-5" />真实支付二维码预留位</span></div>{purchase.error && <p role="alert" className="mt-3 text-sm text-destructive">{purchase.error.message}</p>}<Button type="button" className="mt-5 h-11 w-full rounded-xl" disabled={!channel || purchase.isPending} onClick={() => purchase.mutate()}>{purchase.isPending ? <><LoaderCircle className="animate-spin" />处理中</> : '模拟支付成功'}</Button></div>}</DialogContent></Dialog>;
}
