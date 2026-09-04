'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck, X } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { api } from '@/src/services/api';
import { queryKeys } from '@/src/services/queryKeys';

export function NotificationSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const notices = useQuery({ queryKey: queryKeys.notifications, queryFn: api.listNotifications, enabled: open });
  const read = useMutation({ mutationFn: api.markNotificationRead, onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.notifications }) });
  if (!open) return null;
  return <div className="fixed inset-0 z-50 bg-black/45" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><aside role="dialog" aria-modal="true" aria-label="通知中心" className="absolute inset-y-0 right-0 w-full max-w-md border-l border-border bg-background p-5 shadow-2xl"><header className="flex items-center justify-between"><div><h2 className="text-xl font-semibold">通知中心</h2><p className="mt-1 text-sm text-muted-foreground">任务与账户动态</p></div><Button type="button" variant="ghost" size="icon" aria-label="关闭通知" onClick={onClose}><X /></Button></header><div className="mt-6 space-y-2">{notices.data?.map((notice) => <article key={notice.id} className={`rounded-2xl border p-4 ${notice.read ? 'border-border bg-card/50' : 'border-primary/20 bg-primary/6'}`}><div className="flex items-start gap-3"><span className={`mt-0.5 grid size-9 place-items-center rounded-xl ${notice.read ? 'bg-secondary text-muted-foreground' : 'bg-primary text-primary-foreground'}`}><Bell className="size-4" /></span><div className="min-w-0 flex-1"><h3 className="text-sm font-semibold">{notice.title}</h3><p className="mt-1 text-sm leading-6 text-muted-foreground">{notice.content}</p><p className="mt-2 text-xs text-muted-foreground">{new Date(notice.createdAt).toLocaleString('zh-CN')}</p></div>{!notice.read && <Button type="button" variant="ghost" size="icon-sm" aria-label={`标记${notice.title}为已读`} onClick={() => read.mutate(notice.id)}><CheckCheck /></Button>}</div>{notice.href && <NavLink to={notice.href} onClick={onClose} className="mt-3 inline-block text-xs text-primary">查看详情</NavLink>}</article>)}</div></aside></div>;
}
