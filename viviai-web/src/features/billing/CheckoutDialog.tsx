'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  accountKey,
  billingApi,
  money,
  type Channel,
  type CreditPack,
} from './billingApi';
type Attempt = { key: string; channel: Channel; orderId?: string };
function loadAttempt(key: string): Attempt | undefined {
  try {
    const data = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (
      data &&
      typeof data.key === 'string' &&
      ['wechat', 'alipay'].includes(data.channel)
    )
      return data;
  } catch {
    /* Corrupt local state is not payment evidence. */
  }
}
export function CheckoutDialog({
  plan,
  userId,
  channels,
  resumeId,
  onClose,
  onSaved,
}: {
  plan?: CreditPack;
  userId: string;
  channels: Channel[];
  resumeId?: string;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const client = useQueryClient();
  const storageKey =
    'viviai:payment-attempt:' + userId + ':' + (plan?.id ?? 'resume');
  const [attempt, setAttempt] = useState(() => loadAttempt(storageKey));
  const [channel, setChannel] = useState<Channel | undefined>(attempt?.channel);
  const [orderId, setOrderId] = useState(resumeId ?? attempt?.orderId);
  const queryKey = ['billing', 'order', userId, orderId];
  const order = useQuery({
    queryKey,
    queryFn: () => billingApi.order(orderId!),
    enabled: Boolean(orderId),
    refetchInterval: (query) =>
      query.state.data?.status === 'paid' || query.state.error ? false : 3000,
  });
  const purchase = useMutation({
    mutationFn: async () => {
      if (!plan || !channel) throw new Error('请选择支付方式。');
      const next = attempt ?? { key: crypto.randomUUID(), channel };
      localStorage.setItem(storageKey, JSON.stringify(next));
      setAttempt(next);
      const result = await billingApi.create(plan.id, next.channel, next.key);
      localStorage.setItem(
        storageKey,
        JSON.stringify({ ...next, orderId: result.id }),
      );
      localStorage.setItem('viviai:payment-order:' + userId, result.id);
      return result;
    },
    onSuccess: (data) => {
      client.setQueryData(['billing', 'order', userId, data.id], data);
      setOrderId(data.id);
      onSaved(data.id);
    },
  });
  const sync = useMutation({
    mutationFn: () => billingApi.sync(orderId!),
    onSuccess: async (data) => {
      client.setQueryData(queryKey, data);
      if (data.status === 'paid')
        await client.invalidateQueries({ queryKey: accountKey });
    },
  });
  const current = order.data;
  const resolvedStorageKey =
    'viviai:payment-attempt:' +
    userId +
    ':' +
    (current?.planId ?? plan?.id ?? 'resume');
  const error = purchase.error ?? order.error ?? sync.error;
  const paid = current?.status === 'paid' && Boolean(current.fulfilledAt);
  useEffect(() => {
    if (!paid) return;
    try {
      if (loadAttempt(resolvedStorageKey)?.orderId === current?.id)
        localStorage.removeItem(resolvedStorageKey);
    } catch {
      /* The paid order remains queryable. */
    }
    void client.invalidateQueries({ queryKey: accountKey });
  }, [paid, current?.id, resolvedStorageKey, client]);
  const expired =
    current && new Date(current.expiresAt).getTime() <= Date.now();
  const checkout = !paid && !expired ? current?.checkout : null;
  const summary = current ?? plan;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          void client.invalidateQueries({ queryKey: accountKey });
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-md rounded-[26px] border border-border bg-card p-6">
        <DialogHeader>
          <DialogTitle className="text-2xl">
            {paid ? '积分已到账' : orderId ? '等待支付确认' : '确认购买'}
          </DialogTitle>
          <DialogDescription>
            一次性购买，不自动续费。支付结果以服务端确认到账为准。
          </DialogDescription>
        </DialogHeader>
        {summary && (
          <div className="rounded-2xl border border-primary/15 bg-primary/6 p-4">
            <p>{summary.name}</p>
            <p className="mt-2 text-3xl font-semibold">
              {money(summary.amountMinor)}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              {summary.credits.toLocaleString()} 积分 · 到账后{' '}
              {summary.durationDays} 天有效
            </p>
          </div>
        )}
        {paid ? (
          <div className="space-y-4 py-4 text-center">
            <CheckCircle2 className="mx-auto size-12 text-primary" />
            <p>积分已发放到真实账户。</p>
            <Button
              onClick={() => {
                void client.invalidateQueries({ queryKey: accountKey });
                onClose();
              }}
            >
              完成
            </Button>
          </div>
        ) : (
          <>
            {!orderId && (
              <fieldset disabled={Boolean(attempt) || purchase.isPending}>
                <legend className="mb-2 text-sm">支付方式</legend>
                <div className="grid grid-cols-2 gap-3">
                  {(['wechat', 'alipay'] as const).map((value) => (
                    <label
                      key={value}
                      className="flex items-center gap-2 rounded-xl border border-border p-3 text-sm"
                    >
                      <input
                        type="radio"
                        name="payment-channel"
                        aria-label={value === 'wechat' ? '微信支付' : '支付宝'}
                        checked={channel === value}
                        disabled={!channels.includes(value)}
                        onChange={() => setChannel(value)}
                      />
                      {value === 'wechat' ? '微信支付' : '支付宝'}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            {orderId && !current && !error && (
              <p role="status">正在读取订单…</p>
            )}
            {checkout?.kind === 'qr' && (
              <div className="space-y-3 text-center">
                <QRCodeSVG
                  value={checkout.url}
                  size={208}
                  marginSize={4}
                  aria-label="微信支付二维码"
                  className="mx-auto rounded-xl"
                />
                <p className="text-sm text-muted-foreground">
                  请用另一台设备上的微信扫码付款
                </p>
              </div>
            )}
            {checkout?.kind === 'redirect' && (
              <a
                href={checkout.url}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-xl bg-primary p-3 text-center font-medium text-primary-foreground"
              >
                前往支付宝付款
              </a>
            )}
            {current && !checkout && (
              <p className="text-sm text-muted-foreground">
                {expired
                  ? '订单支付入口已过期。如已付款，请查询结果，不要重复购买。'
                  : '正在确认原订单，请稍后查询，不要重复付款。'}
              </p>
            )}
            {expired && (
              <Button
                variant="ghost"
                onClick={() => {
                  if (loadAttempt(resolvedStorageKey)?.orderId === current?.id)
                    localStorage.removeItem(resolvedStorageKey);
                  onClose();
                }}
              >
                确认未付款，返回选择
              </Button>
            )}
            {current && (
              <p className="break-all text-xs text-muted-foreground">
                订单号：{current.orderNo}
              </p>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error.message}
              </p>
            )}
            {orderId ? (
              <Button disabled={sync.isPending} onClick={() => sync.mutate()}>
                {sync.isPending ? '查询中…' : '查询支付结果'}
              </Button>
            ) : (
              <Button
                disabled={!channel || purchase.isPending}
                onClick={() => purchase.mutate()}
              >
                {purchase.isPending
                  ? '正在创建订单…'
                  : attempt
                    ? '重试原订单'
                    : '确认下单'}
              </Button>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
