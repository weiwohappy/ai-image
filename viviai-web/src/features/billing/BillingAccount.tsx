'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { billingApi, accountKey } from './billingApi';
export function BillingAccountLogin() {
  const client = useQueryClient();
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const login = useMutation({
    mutationFn: () => billingApi.login(account, password),
    onSuccess: (data) => {
      setPassword('');
      client.setQueryData(accountKey, data);
    },
  });
  return (
    <form
      className="mt-6 space-y-4 rounded-2xl border border-border bg-card p-5"
      onSubmit={(event) => {
        event.preventDefault();
        login.mutate();
      }}
    >
      <h2 className="text-lg font-semibold">登录真实账户</h2>
      <p className="text-sm text-muted-foreground">
        创作演示账户不能用于付款。请使用后端已注册的账户登录。
      </p>
      <label className="block space-y-2 text-sm">
        <span>邮箱或用户名</span>
        <Input
          required
          autoComplete="username"
          value={account}
          onChange={(event) => setAccount(event.target.value)}
        />
      </label>
      <label className="block space-y-2 text-sm">
        <span>密码</span>
        <Input
          required
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
      {login.error && (
        <p role="alert" className="text-sm text-destructive">
          {login.error.message}
        </p>
      )}
      <Button disabled={login.isPending} type="submit">
        {login.isPending ? '登录中…' : '登录付款账户'}
      </Button>
    </form>
  );
}
