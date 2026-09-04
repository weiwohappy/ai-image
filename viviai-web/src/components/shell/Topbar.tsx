'use client';

import { useQuery } from '@tanstack/react-query';
import { Bell, CircleDot, Coins, Search } from 'lucide-react';
import { NavLink } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { api } from '@/src/services/api';
import { queryKeys } from '@/src/services/queryKeys';
import { TaskDrawer } from '@/src/components/tasks/TaskDrawer';

export function Topbar() {
  const { data: me } = useQuery({ queryKey: queryKeys.me, queryFn: api.getMe });
  const { data: tasks = [] } = useQuery({ queryKey: queryKeys.tasks, queryFn: api.listGenerationTasks });
  const activeCount = tasks.filter((task) => task.status === 'queued' || task.status === 'processing').length;

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-border bg-background/90 px-4 backdrop-blur-xl md:px-6">
      <SidebarTrigger className="md:hidden" aria-label="打开导航" />
      <div className="hidden min-w-0 flex-1 items-center md:flex">
        <span className="flex items-center gap-2 text-sm text-muted-foreground"><CircleDot className="size-4 text-primary" />创作系统运行正常</span>
      </div>
      <Button variant="ghost" size="sm" className="hidden rounded-full text-muted-foreground lg:flex">
        <Search /> 搜索作品
      </Button>
      {me ? (
        <NavLink to="/pricing" className="flex h-9 items-center gap-2 rounded-full border border-border bg-card px-3 text-sm text-foreground hover:border-primary/40">
          <Coins className="size-4 text-primary" />
          <strong>{me.credits.toLocaleString()}</strong>
          <span className="hidden text-muted-foreground sm:inline">积分</span>
        </NavLink>
      ) : (
        <Button render={<NavLink to="/login" />} nativeButton={false} size="sm" className="rounded-full px-4">登录</Button>
      )}
      <TaskDrawer activeCount={activeCount} />
      <Button variant="ghost" size="icon" aria-label="查看通知" className="rounded-full">
        <Bell />
      </Button>
    </header>
  );
}
