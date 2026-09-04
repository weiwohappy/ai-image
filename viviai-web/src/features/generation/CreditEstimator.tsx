import { Coins } from 'lucide-react';

export function CreditEstimator({ credits, available }: { credits: number; available?: number }) {
  return <div className="mt-4 flex items-center justify-between rounded-xl border border-primary/15 bg-primary/6 px-3 py-2.5 text-sm"><span className="flex items-center gap-2 text-muted-foreground"><Coins className="size-4 text-primary" />本次任务</span><strong className="text-primary">预计消耗 {credits} 积分</strong>{available !== undefined && <span className="sr-only">可用积分 {available}</span>}</div>;
}
