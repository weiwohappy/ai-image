'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { CreditCard, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { accountKey, billingApi, money, type CreditPack } from './billingApi';
import { CheckoutDialog } from './CheckoutDialog';
import { BillingAccountLogin } from './BillingAccount';
export function PricingPage() {
  const client = useQueryClient();
  const catalog = useQuery({
    queryKey: ['billing', 'catalog'],
    queryFn: billingApi.catalog,
  });
  const me = useQuery({
    queryKey: accountKey,
    queryFn: billingApi.me,
    enabled: Boolean(catalog.data?.enabled),
  });
  const [selected, setSelected] = useState<CreditPack>();
  const [resume, setResume] = useState<string>();
  const [lastSaved, setLastSaved] = useState<string>();
  const logout = useMutation({
    mutationFn: billingApi.logout,
    onSuccess: () => {
      setSelected(undefined);
      setResume(undefined);
      client.removeQueries({ queryKey: ['billing', 'order'] });
      client.setQueryData(accountKey, null);
    },
  });
  const user = me.data;
  let lastOrder = lastSaved;
  try {
    if (user)
      lastOrder =
        localStorage.getItem('viviai:payment-order:' + user.id) ?? undefined;
  } catch {
    /* Nonessential resume hint. */
  }
  const close = () => {
    setSelected(undefined);
    setResume(undefined);
  };
  return (
    <main className="mx-auto w-full max-w-5xl p-4 md:p-8">
      <header>
        <p className="text-sm font-medium text-primary">PLANS & CREDITS</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          购买创作积分
        </h1>
        <p className="mt-3 text-base text-muted-foreground">
          一次性购买，按需使用，不自动续费。
        </p>
      </header>
      <div className="mt-6 rounded-2xl border border-border bg-card p-4 text-sm text-muted-foreground">
        创作功能目前仍使用演示数据。这里的支付订单与真实积分独立记录，不会增加演示余额。
      </div>
      {catalog.isPending ? (
        <p role="status" className="mt-8">
          正在读取支付配置…
        </p>
      ) : !catalog.data?.enabled ? (
        <section className="mt-8 rounded-[26px] border border-border bg-card p-8">
          <CreditCard className="size-9 text-primary" />
          <h2 className="mt-4 text-2xl font-semibold">支付暂未开通</h2>
          <p className="mt-3 text-muted-foreground">
            微信支付、支付宝开通后可在此购买积分。当前不会创建支付订单或扣款。
          </p>
          {catalog.error && (
            <p className="mt-3 text-sm text-muted-foreground">
              支付服务尚未连接，可稍后重试。
            </p>
          )}
          <Button
            variant="outline"
            className="mt-5"
            onClick={() => void catalog.refetch()}
          >
            刷新状态
          </Button>
        </section>
      ) : (
        <>
          {user ? (
            <div className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-primary/20 bg-primary/5 p-5">
              <div>
                <p className="text-sm">真实账户：{user.email}</p>
                <p className="mt-2 text-xl font-semibold">
                  {user.credits.toLocaleString()} 可用积分
                </p>
              </div>
              <div className="flex gap-2">
                {lastOrder && (
                  <Button
                    variant="outline"
                    onClick={() => setResume(lastOrder)}
                  >
                    查看最近订单
                  </Button>
                )}
                <Button
                  variant="ghost"
                  disabled={logout.isPending}
                  onClick={() => logout.mutate()}
                >
                  退出账户
                </Button>
              </div>
            </div>
          ) : (
            !me.isPending && <BillingAccountLogin />
          )}
          {logout.error && (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {logout.error.message}
            </p>
          )}
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            {catalog.data.plans.map((plan) => (
              <article
                key={plan.id}
                className="rounded-[26px] border border-border bg-card p-6"
              >
                <h2 className="text-lg">{plan.name}</h2>
                <p className="mt-4 text-4xl font-semibold">
                  {money(plan.amountMinor)}
                </p>
                <p className="mt-5 text-xl font-semibold text-primary">
                  {plan.credits.toLocaleString()} 积分
                </p>
                <p className="mt-2 text-sm text-muted-foreground">
                  到账后 {plan.durationDays} 天有效
                </p>
                <Button
                  className="mt-6 w-full rounded-xl"
                  disabled={!user}
                  onClick={() => setSelected(plan)}
                  aria-label={'购买' + plan.name}
                >
                  购买{plan.name}
                </Button>
              </article>
            ))}
          </div>
        </>
      )}
      <p className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
        <ShieldCheck className="size-4" />
        付款结果由支付渠道与服务器核实，重复通知不会重复发放积分。
      </p>
      {user && (selected || resume) && (
        <CheckoutDialog
          key={user.id + ':' + (selected?.id ?? resume)}
          {...(selected ? { plan: selected } : {})}
          {...(resume ? { resumeId: resume } : {})}
          userId={user.id}
          channels={
            catalog.data?.channels
              .filter((c) => c.enabled)
              .map((c) => c.channel) ?? []
          }
          onClose={close}
          onSaved={setLastSaved}
        />
      )}
    </main>
  );
}
