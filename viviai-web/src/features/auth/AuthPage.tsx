'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Eye, EyeOff, LoaderCircle } from 'lucide-react';
import { FormEvent, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, ApiError, isRealApi } from '@/src/services/api';
import { queryKeys } from '@/src/services/queryKeys';
import { consumeAuthRedirect, rememberAuthRedirect } from './authDraft';

type Mode = 'login' | 'register' | 'forgot';

const fieldClass = 'mt-2 h-11 rounded-xl bg-background px-3 text-base';

export function AuthPage({ mode }: { mode: Mode }) {
  const title = mode === 'login' ? '登录 VIVIAI' : mode === 'register' ? '创建 VIVIAI 账户' : '找回密码';
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [account, setAccount] = useState(mode === 'login' ? 'demo@viviai.local' : '');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState(mode === 'login' ? 'demo1234' : '');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [code, setCode] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [formError, setFormError] = useState('');
  const redirect = new URLSearchParams(location.search).get('redirect') ?? '/create';

  useEffect(() => {
    if (mode === 'login') rememberAuthRedirect(redirect);
  }, [mode, redirect]);

  useEffect(() => {
    if (!countdown) return;
    const timer = window.setInterval(() => setCountdown((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [countdown]);

  const auth = useMutation({
    mutationFn: async () => {
      if (mode !== 'login' && password.length < 12) throw new Error('密码至少需要 12 位。');
      if (mode === 'login') return api.login({ account, password });
      if (!account.includes('@')) throw new Error('请输入有效邮箱。');
      if (!/^\d{6}$/.test(code)) throw new Error('请输入 6 位验证码。');
      if (password !== confirmPassword) throw new Error('两次输入的密码不一致。');
      if (mode === 'register') {
        if (!/^[a-z0-9_]{3,32}$/.test(username.trim().toLowerCase())) throw new Error('用户名需为 3–32 位字母、数字或下划线。');
        return api.register({ username, email: account, password, code });
      }
      await api.resetPassword({ email: account, code, password });
      return null;
    },
    onSuccess: async (user) => {
      if (mode === 'forgot') {
        navigate('/login?reset=success', { replace: true });
        return;
      }
      queryClient.clear();
      if (user) queryClient.setQueryData(queryKeys.me, user);
      navigate(consumeAuthRedirect(redirect), { replace: true });
    },
    onError: (error) => setFormError(error instanceof ApiError || error instanceof Error ? error.message : '操作失败，请重试。'),
  });

  const sendCode = useMutation({
    mutationFn: () => api.sendCode(account, mode === 'forgot' ? 'reset-password' : 'register'),
    onSuccess: () => {
      setFormError(isRealApi() ? '验证码已发送，请查收邮箱。' : '验证码已发送；演示环境请输入任意 6 位数字。');
      setCountdown(60);
    },
    onError: (error) => setFormError(error instanceof Error ? error.message : '验证码发送失败。'),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setFormError('');
    auth.mutate();
  }

  return (
    <main className="relative grid min-h-screen place-items-center overflow-hidden bg-background px-5 py-10">
      <div className="pointer-events-none absolute -left-32 top-[-14rem] size-[34rem] rounded-full bg-primary/8 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-48 right-[-10rem] size-[38rem] rounded-full bg-violet-500/10 blur-3xl" />
      <section className="relative w-full max-w-md rounded-[28px] border border-border bg-card/95 p-7 shadow-2xl shadow-black/30 backdrop-blur md:p-9">
        <Link to="/create" className="mb-9 flex items-center gap-3 text-base font-bold"><span className="grid size-10 place-items-center rounded-[14px] bg-primary text-xl font-black text-primary-foreground">V</span>VIVIAI</Link>
        <h1 className="text-3xl font-semibold tracking-[-.04em]">{title}</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">{mode === 'login' ? '登录后继续刚才的创作，提示词和参数会保留。' : mode === 'register' ? '新用户注册即送 5 积分，先完成你的第一张作品。' : '验证邮箱后设置新密码。'}</p>

        <form className="mt-7 space-y-4" onSubmit={submit}>
          {mode === 'register' && <label className="block text-sm font-medium">用户名<Input className={fieldClass} value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="name" /></label>}
          <label className="block text-sm font-medium">{mode === 'login' ? '用户名或邮箱' : '邮箱'}<Input className={fieldClass} type={mode === 'login' ? 'text' : 'email'} value={account} onChange={(event) => setAccount(event.target.value)} autoComplete="email" /></label>
          {mode !== 'login' && <label className="block text-sm font-medium">验证码<span className="mt-2 flex gap-2"><Input aria-label="验证码" className="h-11 rounded-xl bg-background px-3 text-base" inputMode="numeric" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} /><Button type="button" variant="outline" className="h-11 shrink-0 rounded-xl" disabled={countdown > 0 || sendCode.isPending || !account.includes('@')} onClick={() => sendCode.mutate()}>{countdown ? `${countdown}s` : '发送验证码'}</Button></span></label>}
          <label className="block text-sm font-medium">{mode === 'forgot' ? '新密码' : '密码'}<span className="relative mt-2 block"><Input aria-label={mode === 'forgot' ? '新密码' : '密码'} className="h-11 rounded-xl bg-background px-3 pr-11 text-base" type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /><button type="button" className="absolute inset-y-0 right-0 grid w-11 place-items-center text-muted-foreground" aria-label={showPassword ? '隐藏密码' : '显示密码'} onClick={() => setShowPassword((value) => !value)}>{showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</button></span></label>
          {mode !== 'login' && <label className="block text-sm font-medium">确认密码<Input className={fieldClass} type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" /></label>}
          {formError && <p role="status" className={`rounded-xl border px-3 py-2.5 text-sm ${formError.includes('已发送') ? 'border-primary/25 bg-primary/8 text-primary' : 'border-destructive/25 bg-destructive/8 text-destructive'}`}>{formError}</p>}
          <Button type="submit" className="h-12 w-full rounded-2xl font-bold" disabled={auth.isPending}>{auth.isPending && <LoaderCircle className="animate-spin" />}{mode === 'login' ? '登录' : mode === 'register' ? '注册并登录' : '重置密码'}</Button>
        </form>

        <div className="mt-6 flex items-center justify-between text-sm text-muted-foreground">{mode === 'login' ? <><Link className="hover:text-foreground" to="/forgot-password"><ArrowLeft className="mr-1 inline size-3" />忘记密码</Link><Link className="text-primary hover:underline" to="/register">免费注册</Link></> : <Link className="hover:text-foreground" to="/login"><ArrowLeft className="mr-1 inline size-3" />返回登录</Link>}</div>
        {mode === 'login' && <p className="mt-6 rounded-xl bg-secondary px-3 py-2 text-xs leading-5 text-muted-foreground">演示账号：demo@viviai.local　密码：demo1234</p>}
      </section>
    </main>
  );
}
