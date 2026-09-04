'use client';

import { useQuery } from '@tanstack/react-query';
import { Check, Copy, Gift, Users } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { api } from '@/src/services/api';
import { queryKeys } from '@/src/services/queryKeys';

export function InvitePage() {
  const me = useQuery({ queryKey: queryKeys.me, queryFn: api.getMe });
  const invites = useQuery({ queryKey: queryKeys.invites, queryFn: api.listInvites });
  const [copied, setCopied] = useState(false);
  const link = `https://viviai.local/register?invite=${me.data?.inviteCode ?? ''}`;
  async function copy() { await navigator.clipboard?.writeText(link); setCopied(true); window.setTimeout(() => setCopied(false), 1600); }
  const rewards = invites.data?.filter((item) => item.status === 'rewarded').reduce((total, item) => total + item.reward, 0) ?? 0;
  return <main className="mx-auto w-full max-w-[1240px] p-4 md:p-6 xl:p-8"><header className="rounded-[30px] border border-primary/15 bg-[radial-gradient(circle_at_80%_10%,rgba(216,255,82,.16),transparent_30%),var(--card)] p-7 md:p-10"><p className="flex items-center gap-2 text-sm font-medium text-primary"><Gift className="size-4" />INVITE & EARN</p><h1 className="mt-3 max-w-2xl text-3xl font-semibold tracking-[-.045em] md:text-5xl">邀请朋友一起创作，<br />双方都得积分</h1><p className="mt-4 text-base text-muted-foreground">分享你的专属链接。好友完成注册后，奖励自动到账。</p><div className="mt-7 flex max-w-2xl items-center gap-2 rounded-2xl border border-border bg-background p-2 pl-4"><span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{link}</span><Button type="button" className="shrink-0 rounded-xl" onClick={copy}>{copied ? <Check /> : <Copy />}{copied ? '已复制' : '复制邀请链接'}</Button></div></header><div className="mt-5 grid gap-5 md:grid-cols-[.65fr_1.35fr]"><section className="rounded-[26px] border border-border bg-card p-6"><p className="flex items-center gap-2 text-sm text-muted-foreground"><Users className="size-4 text-primary" />累计邀请</p><strong className="mt-3 block text-4xl">{invites.data?.length ?? 0}</strong><p className="mt-6 flex items-center gap-2 text-sm text-muted-foreground"><Gift className="size-4 text-primary" />累计奖励</p><strong className="mt-3 block text-4xl text-primary">{rewards} 积分</strong></section><section className="rounded-[26px] border border-border bg-card p-6"><h2 className="text-lg font-semibold">邀请记录</h2><div className="mt-4 space-y-2">{invites.data?.map((invite) => <div key={invite.id} className="flex items-center justify-between rounded-xl bg-background p-3"><div><strong className="text-sm">{invite.username}</strong><p className="mt-1 text-xs text-muted-foreground">{new Date(invite.createdAt).toLocaleDateString('zh-CN')}</p></div><span className={invite.status === 'rewarded' ? 'text-sm text-primary' : 'text-sm text-muted-foreground'}>{invite.status === 'rewarded' ? `+${invite.reward} 积分` : '待完成'}</span></div>)}</div></section></div></main>;
}
