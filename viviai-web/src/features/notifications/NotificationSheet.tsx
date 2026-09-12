'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck, RefreshCw } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { api } from '@/src/services/api';
import { queryKeys } from '@/src/services/queryKeys';
import type { NotificationItem } from '@/src/types/domain';

function safeInternalHref(href: string | undefined): href is string {
  if (!href || !href.startsWith('/') || href.startsWith('//') || href.includes('\\')) return false;
  for (let index = 0; index < href.length; index += 1) {
    const code = href.charCodeAt(index);
    if (code <= 31 || code === 127) return false;
  }
  return true;
}

export function NotificationSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const notices = useQuery({ queryKey: queryKeys.notifications, queryFn: api.listNotifications, enabled: open });
  const markRead = useMutation({
    mutationFn: api.markNotificationRead,
    onSuccess: (updated) => {
      queryClient.setQueryData<NotificationItem[]>(queryKeys.notifications, (current) => current?.map((notice) => notice.id === updated.id ? updated : notice));
    },
  });
  const markAllRead = useMutation({
    mutationFn: api.markAllNotificationsRead,
    onSuccess: () => {
      queryClient.setQueryData<NotificationItem[]>(queryKeys.notifications, (current) => current?.map((notice) => ({ ...notice, read: true })));
    },
  });
  const unread = notices.data?.filter((notice) => !notice.read) ?? [];
  return <Sheet open={open} onOpenChange={(next) => { if (!next) onClose(); }}><SheetContent className="w-full max-w-md border-border bg-background p-5 shadow-2xl"><SheetHeader className="p-0 pr-10"><div className="flex items-center justify-between gap-3"><div><SheetTitle className="text-xl font-semibold">通知中心</SheetTitle><SheetDescription>任务与账户动态 · <span aria-label={`未读 ${unread.length}`}>未读 {unread.length}</span></SheetDescription></div>{unread.length > 0 && <Button type="button" variant="ghost" size="sm" disabled={markAllRead.isPending} onClick={() => markAllRead.mutate()}><CheckCheck />全部标为已读</Button>}</div></SheetHeader><div className="mt-2 space-y-2 overflow-y-auto">{notices.isPending && <div className="space-y-2" aria-label="正在加载通知"><div className="h-24 animate-pulse rounded-2xl bg-card" /><div className="h-24 animate-pulse rounded-2xl bg-card" /></div>}{notices.isError && <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">通知加载失败。<Button type="button" variant="outline" size="sm" className="ml-2" onClick={() => notices.refetch()}><RefreshCw />重试</Button></div>}{!notices.isPending && !notices.isError && notices.data?.length === 0 && <div className="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">暂时没有通知。</div>}{notices.data?.map((notice) => <article key={notice.id} className={`rounded-2xl border p-4 ${notice.read ? 'border-border bg-card/50' : 'border-primary/20 bg-primary/6'}`}><div className="flex items-start gap-3"><span className={`mt-0.5 grid size-9 place-items-center rounded-xl ${notice.read ? 'bg-secondary text-muted-foreground' : 'bg-primary text-primary-foreground'}`}><Bell className="size-4" /></span><div className="min-w-0 flex-1"><h3 className="text-sm font-semibold">{notice.title}</h3><p className="mt-1 text-sm leading-6 text-muted-foreground">{notice.content}</p><p className="mt-2 text-xs text-muted-foreground">{new Date(notice.createdAt).toLocaleString('zh-CN')}</p></div>{!notice.read && <Button type="button" variant="ghost" size="icon-sm" aria-label={`标记${notice.title}为已读`} disabled={markRead.isPending} onClick={() => markRead.mutate(notice.id)}><CheckCheck /></Button>}</div>{safeInternalHref(notice.href) && <NavLink to={notice.href} onClick={onClose} className="mt-3 inline-block text-xs text-primary">查看详情</NavLink>}</article>)}{markAllRead.isSuccess && <p role="status" className="text-center text-xs text-primary">全部通知已读</p>}{markRead.isError || markAllRead.isError ? <p role="status" className="text-center text-xs text-destructive">标记通知失败，请重试。</p> : null}</div></SheetContent></Sheet>;
}
