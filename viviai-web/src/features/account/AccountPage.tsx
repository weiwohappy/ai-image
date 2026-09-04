'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Coins, Copy, KeyRound, LoaderCircle, LogOut, Shield, UserRound } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/src/services/api';
import { queryKeys } from '@/src/services/queryKeys';
import type { User } from '@/src/types/domain';
import { PointLedger } from './PointLedger';

export function AccountPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: queryKeys.me, queryFn: api.getMe });
  const ledger = useQuery({ queryKey: queryKeys.ledger, queryFn: api.listPointLedger });
  const [code, setCode] = useState('');
  const [message, setMessage] = useState('');
  const redeem = useMutation<User, Error>({ mutationFn: () => api.redeemCode(code), onSuccess: (user) => { queryClient.setQueryData(queryKeys.me, user); queryClient.invalidateQueries({ queryKey: queryKeys.ledger }); setMessage('兑换成功，100 积分已到账。'); setCode(''); }, onError: (error) => setMessage(error.message) });
  const logout = useMutation({ mutationFn: api.logout, onSuccess: async () => { queryClient.setQueryData(queryKeys.me, null); navigate('/login'); } });
  if (!me.data) return <main className="p-8"><div className="h-64 animate-pulse rounded-[28px] bg-card" /></main>;
  const user = me.data;
  return <main className="mx-auto w-full max-w-[1380px] p-4 md:p-6 xl:p-8"><header><p className="flex items-center gap-2 text-sm font-medium text-primary"><UserRound className="size-4" />ACCOUNT</p><h1 className="mt-2 text-3xl font-semibold tracking-[-.04em] md:text-4xl">个人中心</h1></header><div className="mt-7 grid gap-5 xl:grid-cols-[.72fr_1.28fr]"><div className="space-y-5"><section className="rounded-[26px] border border-border bg-card p-6"><div className="flex items-center gap-4"><span className="grid size-16 place-items-center rounded-2xl bg-primary text-2xl font-black text-primary-foreground">{user.username.slice(0, 1).toUpperCase()}</span><div><h2 className="text-xl font-semibold">{user.username}</h2><p className="mt-1 text-sm text-muted-foreground">{user.email}</p></div></div><div className="mt-6 grid grid-cols-2 gap-3"><div className="rounded-2xl bg-background p-4"><p className="flex items-center gap-2 text-xs text-muted-foreground"><Coins className="size-4 text-primary" />可用积分</p><strong className="mt-2 block text-3xl">{user.credits.toLocaleString()}</strong></div><div className="rounded-2xl bg-background p-4"><p className="flex items-center gap-2 text-xs text-muted-foreground"><Shield className="size-4 text-violet-300" />当前套餐</p><strong className="mt-2 block text-base">{user.planName}</strong><p className="mt-1 text-xs text-muted-foreground">并发 {user.concurrency}</p></div></div><Button type="button" variant="ghost" className="mt-5 text-muted-foreground" onClick={() => logout.mutate()}><LogOut />退出登录</Button></section><section className="rounded-[26px] border border-border bg-card p-6"><h2 className="flex items-center gap-2 text-lg font-semibold"><KeyRound className="size-5 text-primary" />兑换积分</h2><p className="mt-2 text-sm text-muted-foreground">演示兑换码：VIVIAI2026</p><div className="mt-4 flex gap-2"><Input aria-label="兑换码" className="h-11 bg-background uppercase" value={code} onChange={(event) => setCode(event.target.value)} placeholder="输入兑换码" /><Button type="button" className="h-11 shrink-0" disabled={!code.trim() || redeem.isPending} onClick={() => redeem.mutate()}>{redeem.isPending && <LoaderCircle className="animate-spin" />}兑换积分</Button></div>{message && <p role="status" className={`mt-3 text-sm ${message.includes('成功') ? 'text-primary' : 'text-destructive'}`}>{message}</p>}</section><section className="rounded-[26px] border border-border bg-card p-6"><h2 className="text-lg font-semibold">邀请信息</h2><p className="mt-2 text-sm text-muted-foreground">每位好友注册后，双方获得奖励积分。</p><div className="mt-4 flex items-center justify-between rounded-xl bg-background p-3"><code className="text-sm text-primary">{user.inviteCode}</code><Button type="button" size="icon-sm" variant="ghost" aria-label="复制邀请码" onClick={() => navigator.clipboard?.writeText(user.inviteCode)}><Copy /></Button></div></section></div><section className="rounded-[26px] border border-border bg-card p-6"><div className="flex items-center justify-between"><div><h2 className="text-xl font-semibold">积分明细</h2><p className="mt-1 text-sm text-muted-foreground">冻结、消耗、退款和购买均可追溯。</p></div><span className="rounded-full bg-secondary px-3 py-1.5 text-xs text-muted-foreground">{ledger.data?.length ?? 0} 条</span></div><div className="mt-5"><PointLedger entries={ledger.data ?? []} /></div></section></div></main>;
}
