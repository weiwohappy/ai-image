'use client';

import { useQuery } from '@tanstack/react-query';
import { Check, Copy, Gift, RefreshCw, Share2, Users } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { api } from '@/src/services/api';
import { queryKeys } from '@/src/services/queryKeys';

export function InvitePage() {
  const me = useQuery({ queryKey: queryKeys.me, queryFn: api.getMe });
  const invites = useQuery({ queryKey: queryKeys.invites, queryFn: api.listInvites });
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const inviteCode = me.data?.inviteCode;
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const link = inviteCode ? `${origin}/#/register?invite=${encodeURIComponent(inviteCode)}` : '';
  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard?.writeText(link);
      setCopied(true);
      setCopyError('');
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopyError('复制失败，请手动复制链接。');
    }
  }
  async function share() {
    if (!link) return;
    if (!navigator.share) return copy();
    try {
      await navigator.share({ title: '邀请加入 VIVIAI', text: '邀请你一起创作，注册即可获得积分。', url: link });
    } catch {
      // A cancelled platform share is not an application error.
    }
  }
  const rewards = invites.data?.filter((item) => item.status === 'rewarded').reduce((total, item) => total + item.reward, 0) ?? 0;
  return <main className="mx-auto w-full max-w-[1240px] p-4 md:p-6 xl:p-8"><header className="rounded-[30px] border border-primary/15 bg-[radial-gradient(circle_at_80%_10%,rgba(216,255,82,.16),transparent_30%),var(--card)] p-7 md:p-10"><p className="flex items-center gap-2 text-sm font-medium text-primary"><Gift className="size-4" />INVITE & EARN</p><h1 className="mt-3 max-w-2xl text-3xl font-semibold tracking-[-.045em] md:text-5xl">邀请朋友一起创作，<br />双方都得积分</h1><p className="mt-4 text-base text-muted-foreground">分享你的专属链接。好友完成注册后，奖励自动到账。</p>{me.isPending ? <div className="mt-7 h-14 max-w-2xl animate-pulse rounded-2xl bg-background" aria-label="正在加载邀请链接" /> : me.isError || !inviteCode ? <div className="mt-7 rounded-2xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">邀请链接加载失败。<Button type="button" variant="outline" size="sm" className="ml-2" onClick={() => me.refetch()}><RefreshCw />重试</Button></div> : <div className="mt-7 flex max-w-2xl items-center gap-2 rounded-2xl border border-border bg-background p-2 pl-4"><span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{link}</span><Button type="button" variant="outline" className="shrink-0 rounded-xl" aria-label="分享邀请链接" onClick={share}><Share2 />分享</Button><Button type="button" className="shrink-0 rounded-xl" onClick={copy}>{copied ? <Check /> : <Copy />}{copied ? '已复制' : '复制邀请链接'}</Button></div>}{copyError && <p role="status" className="mt-3 text-sm text-destructive">{copyError}</p>}</header><div className="mt-5 grid gap-5 md:grid-cols-[.65fr_1.35fr]"><section className="rounded-[26px] border border-border bg-card p-6"><p className="flex items-center gap-2 text-sm text-muted-foreground"><Users className="size-4 text-primary" />累计邀请</p><strong className="mt-3 block text-4xl">{invites.data?.length ?? 0}</strong><p className="mt-6 flex items-center gap-2 text-sm text-muted-foreground"><Gift className="size-4 text-primary" />累计奖励</p><strong className="mt-3 block text-4xl text-primary">{rewards} 积分</strong></section><section className="rounded-[26px] border border-border bg-card p-6"><h2 className="text-lg font-semibold">邀请记录</h2>{invites.isPending && <div className="mt-4 h-20 animate-pulse rounded-xl bg-background" aria-label="正在加载邀请记录" />}{invites.isError && <div className="mt-4 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">邀请记录加载失败。<Button type="button" variant="outline" size="sm" className="ml-2" onClick={() => invites.refetch()}><RefreshCw />重试</Button></div>}{!invites.isPending && !invites.isError && invites.data?.length === 0 && <p className="mt-4 rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">还没有邀请记录。</p>}<div className="mt-4 space-y-2">{invites.data?.map((invite) => <div key={invite.id} className="flex items-center justify-between rounded-xl bg-background p-3"><div><strong className="text-sm">{invite.username}</strong><p className="mt-1 text-xs text-muted-foreground">{new Date(invite.createdAt).toLocaleDateString('zh-CN')}</p></div><span className={invite.status === 'rewarded' ? 'text-sm text-primary' : 'text-sm text-muted-foreground'}>{invite.status === 'rewarded' ? `+${invite.reward} 积分` : '待完成'}</span></div>)}</div></section></div></main>;
}
