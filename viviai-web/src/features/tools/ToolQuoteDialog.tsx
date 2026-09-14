'use client';

import { Coins, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import type { ToolRunQuote, ToolTemplate } from '@/src/types/domain';

function field(label: string, value: string) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground">{value}</span>
    </div>
  );
}

export function ToolQuoteDialog({
  open,
  onOpenChange,
  tool,
  quote,
  loading,
  error,
  stale,
  submitting,
  balance,
  onConfirm,
  onReQuote,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tool: ToolTemplate;
  quote?: ToolRunQuote;
  loading: boolean;
  error?: string;
  stale: boolean;
  submitting: boolean;
  balance?: number;
  onConfirm: () => void;
  onReQuote: () => void;
}) {
  const expired = Boolean(quote && new Date(quote.expiresAt).getTime() <= Date.now());
  const confirmDisabled = loading || submitting || !quote || stale || expired;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md rounded-[24px] border-border bg-card p-6">
        <DialogTitle className="text-xl font-semibold">确认生成</DialogTitle>
        <DialogDescription>
          {tool.name} v{tool.version} · 本次任务将由服务器按以下报价结算。
        </DialogDescription>
        {error && (
          <p role="alert" className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </p>
        )}
        {loading ? (
          <div className="grid min-h-[220px] place-items-center text-muted-foreground">
            <span className="flex items-center gap-2">
              <LoaderCircle className="animate-spin" /> 正在获取报价
            </span>
          </div>
        ) : quote ? (
          <div className="space-y-2 rounded-xl border border-border bg-background/50 p-4">
            {field('模型', quote.modelId)}
            {field('分辨率', quote.resolution)}
            {field('比例', quote.ratio)}
            {field('数量', `${quote.count} 张`)}
            {field('单价', `${quote.unitCredits} 积分`)}
            <div className="flex items-center justify-between border-t border-border pt-2 text-sm">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Coins className="size-4 text-primary" />合计
              </span>
              <strong className="text-primary" data-testid="quote-total">{quote.totalCredits} 积分</strong>
            </div>
            <p className="text-xs text-muted-foreground">
              {balance !== undefined && (
                <span className="mr-3">可用积分 {balance}</span>
              )}
              {expired ? (
                <span className="text-destructive">报价已过期</span>
              ) : (
                <span>有效期至 {new Date(quote.expiresAt).toLocaleTimeString()}</span>
              )}
            </p>
            {stale && (
              <p className="text-xs text-amber-600 dark:text-amber-400">参数已变更，请重新报价后再确认。</p>
            )}
          </div>
        ) : null}
        <div className="mt-2 flex gap-2">
          <Button type="button" variant="outline" className="flex-1" disabled={loading || submitting} onClick={onReQuote}>
            重新报价
          </Button>
          <Button type="button" className="flex-1" disabled={confirmDisabled} onClick={onConfirm}>
            {submitting ? <><LoaderCircle className="animate-spin" />正在生成</> : '确认生成'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
