'use client';

import { useQuery } from '@tanstack/react-query';
import { Activity } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { api } from '@/src/services/api';
import { queryKeys } from '@/src/services/queryKeys';

const statusLabel = {
  queued: '正在排队',
  processing: '正在生成',
  succeeded: '生成成功',
  partial: '部分成功',
  failed: '生成失败',
  cancelled: '已取消',
};

export function TaskDrawer({ activeCount }: { activeCount: number }) {
  const { data: me } = useQuery({ queryKey: queryKeys.me, queryFn: api.getMe });
  const { data: tasks = [] } = useQuery({ queryKey: queryKeys.tasks, queryFn: api.listGenerationTasks, enabled: Boolean(me) });

  return (
    <Sheet>
      <SheetTrigger render={<Button variant="ghost" size="sm" className="rounded-full" />}>
        <Activity />
        <span className="hidden sm:inline">任务</span>
        {activeCount > 0 && <span className="grid size-5 place-items-center rounded-full bg-primary text-xs font-bold text-primary-foreground">{activeCount}</span>}
      </SheetTrigger>
      <SheetContent className="border-border bg-popover sm:max-w-md">
        <SheetHeader>
          <SheetTitle>最近任务</SheetTitle>
          <SheetDescription>生成任务会在这里持续更新。</SheetDescription>
        </SheetHeader>
        <div className="space-y-3 overflow-auto px-4 pb-6">
          {tasks.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">还没有生成任务</div>
          ) : (
            tasks.slice(0, 8).map((task) => (
              <article key={task.id} className="rounded-2xl border border-border bg-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <p className="line-clamp-2 text-sm text-foreground">{task.input.prompt}</p>
                  <span className="shrink-0 text-xs text-muted-foreground">{statusLabel[task.status]}</span>
                </div>
                <Progress value={task.progress} className="mt-3" />
              </article>
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
