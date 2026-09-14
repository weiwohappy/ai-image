'use client';

import { Coins, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import type { WorkflowRunQuote } from '@/src/types/domain';

export function WorkflowQuoteDialog({
  open,
  onOpenChange,
  quote,
  loading,
  error,
  stale,
  submitting,
  balance,
  retrying,
  onConfirm,
  onReQuote,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  quote?: WorkflowRunQuote;
  loading: boolean;
  error?: string;
  stale: boolean;
  submitting: boolean;
  balance?: number;
  /** True when quoting a retry of a settled run rather than a fresh selection. */
  retrying?: boolean;
  onConfirm: () => void;
  onReQuote: () => void;
}) {
  const expired = Boolean(quote?.expiresAt && Date.parse(quote.expiresAt) <= Date.now());
  const rejected = quote?.items.filter((item) => item.status === 'invalid') ?? [];
  const confirmDisabled = loading || submitting || !quote?.quoteId || !quote.submittable || stale || expired;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl rounded-[24px] border-border bg-card p-6">
        <DialogTitle className="text-xl font-semibold">{retrying ? '确认重试失败项' : '确认批量生成'}</DialogTitle>
        <DialogDescription>
          {retrying ? '只会重试上一批中失败的项，成功结果不会重复计费。' : '服务器已按当前工作流与所选行逐项报价。'}
        </DialogDescription>
        {error && (
          <p role="alert" className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive">{error}</p>
        )}
        {loading ? (
          <div className="grid min-h-[220px] place-items-center text-muted-foreground">
            <span className="flex items-center gap-2"><LoaderCircle className="animate-spin" /> 正在获取报价</span>
          </div>
        ) : quote ? (
          <div className="space-y-3">
            {quote.items.length ? (
              <div className="max-h-72 overflow-y-auto rounded-xl border border-border">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="bg-secondary/60 text-left text-xs text-muted-foreground">
                      <th className="p-2">行</th>
                      <th className="p-2">列</th>
                      <th className="p-2 text-right">单价</th>
                    </tr>
                  </thead>
                  <tbody>
                    {quote.items.map((item) => (
                      <tr key={`${item.rowKey}:${item.columnId}`} className="border-t border-border">
                        <td className="p-2 font-mono text-xs text-muted-foreground">{item.rowKey.slice(-6)}</td>
                        <td className="p-2">
                          {item.columnName ?? item.columnId}
                          {item.status === 'invalid' && (
                            <span className="ml-2 text-xs text-destructive">{item.error?.message ?? '无法运行'}</span>
                          )}
                        </td>
                        <td className="p-2 text-right">
                          {item.status === 'ready' ? `${item.unitCredits ?? 0} 积分` : <span className="text-destructive">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="rounded-xl border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
                没有可运行的任务。
              </p>
            )}
            {rejected.length > 0 && (
              <p role="alert" className="rounded-xl bg-destructive/10 p-3 text-xs text-destructive">
                有 {rejected.length} 项无法运行，请修正后重新报价。
              </p>
            )}
            <div className="space-y-2 rounded-xl border border-border bg-background/50 p-4">
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-1.5 text-muted-foreground"><Coins className="size-4 text-primary" />合计</span>
                <strong className="text-primary" data-testid="quote-total">{quote.totalCredits} 积分</strong>
              </div>
              <p className="text-xs text-muted-foreground">
                {balance !== undefined && <span className="mr-3">可用积分 {balance}</span>}
                {quote.expiresAt
                  ? expired
                    ? <span className="text-destructive">报价已过期</span>
                    : <span>有效期至 {new Date(quote.expiresAt).toLocaleTimeString('zh-CN')}</span>
                  : null}
              </p>
              {stale && <p className="text-xs text-amber-600 dark:text-amber-400">工作流或所选行已变更，请重新报价后再确认。</p>}
            </div>
          </div>
        ) : null}
        <div className="mt-2 flex gap-2">
          <Button type="button" variant="outline" className="flex-1" disabled={loading || submitting} onClick={onReQuote}>
            重新报价
          </Button>
          <Button type="button" className="flex-1" disabled={confirmDisabled} onClick={onConfirm}>
            {submitting ? <><LoaderCircle className="animate-spin" />正在提交</> : retrying ? '确认重试' : '确认生成'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
