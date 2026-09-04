'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { api } from '@/src/services/api';
import { queryKeys } from '@/src/services/queryKeys';

export function NotificationSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const notices = useQuery({ queryKey: queryKeys.notifications, queryFn: api.listNotifications, enabled: open });
  const read = useMutation({ mutationFn: api.markNotificationRead, onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.notifications }) });
  return <Sheet open={open} onOpenChange={(next) => { if (!next) onClose(); }}><SheetContent className="w-full max-w-md border-border bg-background p-5 shadow-2xl"><SheetHeader className="p-0 pr-10"><SheetTitle className="text-xl font-semibold">通知中心</SheetTitle><SheetDescription>任务与账户动态</SheetDescription></SheetHeader><div className="mt-2 space-y-2 overflow-y-auto">{notices.data?.map((notice) => <article key={notice.id} className={`rounded-2xl border p-4 ${notice.read ? 'border-border bg-card/50' : 'border-primary/20 bg-primary/6'}`}><div className="flex items-start gap-3"><span className={`mt-0.5 grid size-9 place-items-center rounded-xl ${notice.read ? 'bg-secondary text-muted-foreground' : 'bg-primary text-primary-foreground'}`}><Bell className="size-4" /></span><div className="min-w-0 flex-1"><h3 className="text-sm font-semibold">{notice.title}</h3><p className="mt-1 text-sm leading-6 text-muted-foreground">{notice.content}</p><p className="mt-2 text-xs text-muted-foreground">{new Date(notice.createdAt).toLocaleString('zh-CN')}</p></div>{!notice.read && <Button type="button" variant="ghost" size="icon-sm" aria-label={`标记${notice.title}为已读`} onClick={() => read.mutate(notice.id)}><CheckCheck /></Button>}</div>{notice.href && <NavLink to={notice.href} onClick={onClose} className="mt-3 inline-block text-xs text-primary">查看详情</NavLink>}</article>)}</div></SheetContent></Sheet>;
}
