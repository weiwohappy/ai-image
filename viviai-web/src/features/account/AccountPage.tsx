'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, Coins, Copy, KeyRound, LoaderCircle, LogOut, Mail, Save, Shield, UserRound } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, apiResourceUrl, ApiError } from '@/src/services/api';
import { queryKeys } from '@/src/services/queryKeys';
import type { User } from '@/src/types/domain';
import { PointLedger } from './PointLedger';

type MessageKind = 'success' | 'error';
type RedemptionAttempt = { normalizedCode: string; key: string; baselineCredits: number; uncertain?: boolean };

function isUncertainRedemptionError(error: Error): boolean {
  return !(error instanceof ApiError) || error.status >= 500;
}

export function AccountPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: queryKeys.me, queryFn: api.getMe });
  const ledger = useQuery({ queryKey: queryKeys.ledger, queryFn: api.listPointLedger });
  const [code, setCode] = useState('');
  const [message, setMessage] = useState('');
  const [messageKind, setMessageKind] = useState<MessageKind>('success');
  const [username, setUsername] = useState('');
  const [avatarFile, setAvatarFile] = useState<File>();
  const [avatarPreviewUrl, setAvatarPreviewUrl] = useState<string>();
  const [email, setEmail] = useState('');
  const [emailCode, setEmailCode] = useState('');
  const [passwordCode, setPasswordCode] = useState('');
  const [password, setPassword] = useState('');
  const [refreshingRedemptionBaseline, setRefreshingRedemptionBaseline] = useState(false);
  const [submittingRedemption, setSubmittingRedemption] = useState(false);
  const redeemAttempt = useRef<RedemptionAttempt | undefined>(undefined);
  const abandonedUncertainRedemption = useRef(false);
  const refreshingRedemptionBaselineRef = useRef(false);
  const submittingRedemptionRef = useRef(false);

  useEffect(() => {
    if (!me.data) return;
    setUsername(me.data.username);
    setEmail(me.data.email);
  }, [me.data]);

  useEffect(() => () => {
    if (avatarPreviewUrl) URL.revokeObjectURL(avatarPreviewUrl);
  }, [avatarPreviewUrl]);

  const notify = (nextMessage: string, kind: MessageKind) => {
    setMessage(nextMessage);
    setMessageKind(kind);
  };
  const syncUser = (user: User) => queryClient.setQueryData(queryKeys.me, user.avatarUrl ? { ...user, avatarUrl: apiResourceUrl(user.avatarUrl) } : user);
  const releaseRedemptionSubmission = () => {
    submittingRedemptionRef.current = false;
    setSubmittingRedemption(false);
  };
  const profile = useMutation({
    mutationFn: async () => {
      const saved = await api.updateProfile({ username });
      syncUser(saved);
      if (!avatarFile) return saved;
      try {
        return await api.uploadAvatar(avatarFile);
      } catch (error) {
        throw Object.assign(error instanceof Error ? error : new Error('头像上传失败。'), { profileSaved: true });
      }
    },
    onSuccess: (user) => {
      syncUser(user);
      setAvatarFile(undefined);
      setAvatarPreviewUrl(undefined);
      notify('个人资料已保存。', 'success');
    },
    onError: (error: Error & { profileSaved?: boolean }) => notify(error.profileSaved ? '用户名已保存，但头像上传失败。' : error.message, 'error'),
  });
  const changeEmail = useMutation({
    mutationFn: () => api.changeEmail({ email, code: emailCode }),
    onSuccess: (user) => {
      syncUser(user);
      setEmailCode('');
      notify('登录邮箱已更新。', 'success');
    },
    onError: (error: Error) => notify(error.message, 'error'),
  });
  const changePassword = useMutation({
    mutationFn: () => api.changePassword({ code: passwordCode, password }),
    onSuccess: (user) => {
      syncUser(user);
      setPassword('');
      setPasswordCode('');
      notify('密码已更新。', 'success');
    },
    onError: (error: Error) => notify(error.message, 'error'),
  });
  const sendEmailCode = useMutation({
    mutationFn: () => api.sendCode(email, 'change-email'),
    onSuccess: () => notify('验证码已发送，请查收邮箱。', 'success'),
    onError: (error: Error) => notify(error.message, 'error'),
  });
  const sendPasswordCode = useMutation({
    mutationFn: (currentEmail: string) => api.sendCode(currentEmail, 'change-password'),
    onSuccess: () => notify('验证码已发送，请查收当前登录邮箱。', 'success'),
    onError: (error: Error) => notify(error.message, 'error'),
  });
  const redeem = useMutation<User, Error, RedemptionAttempt>({
    mutationFn: (attempt) => api.redeemCode(attempt.normalizedCode, attempt.key),
    onSuccess: (user, attempt) => {
      syncUser(user);
      queryClient.invalidateQueries({ queryKey: queryKeys.me });
      queryClient.invalidateQueries({ queryKey: queryKeys.ledger });
      queryClient.invalidateQueries({ queryKey: queryKeys.notifications });
      const delta = Math.max(0, user.credits - attempt.baselineCredits);
      notify(delta > 0 ? `兑换成功，${delta} 积分已到账。` : '兑换成功。', 'success');
      if (redeemAttempt.current?.key === attempt.key) redeemAttempt.current = undefined;
      setCode('');
      releaseRedemptionSubmission();
    },
    onError: (error, attempt) => {
      if (isUncertainRedemptionError(error) && redeemAttempt.current?.key === attempt.key) redeemAttempt.current.uncertain = true;
      if (!isUncertainRedemptionError(error) && redeemAttempt.current?.key === attempt.key) redeemAttempt.current = undefined;
      notify(error.message, 'error');
      releaseRedemptionSubmission();
    },
  });
  const logout = useMutation({ mutationFn: api.logout, onSuccess: () => { queryClient.clear(); navigate('/login'); } });

  function selectAvatar(file: File) {
    if (file.size > 1024 * 1024) {
      notify('头像不能超过 1MB。', 'error');
      return;
    }
    setAvatarFile(file);
    setAvatarPreviewUrl(URL.createObjectURL(file));
  }

  async function redeemCredits() {
    const normalizedCode = code.trim().toUpperCase();
    if (!normalizedCode || refreshingRedemptionBaselineRef.current || submittingRedemptionRef.current) return;
    submittingRedemptionRef.current = true;
    setSubmittingRedemption(true);
    if (!redeemAttempt.current || redeemAttempt.current.normalizedCode !== normalizedCode) {
      let baselineCredits = me.data?.credits ?? 0;
      if (abandonedUncertainRedemption.current) {
        refreshingRedemptionBaselineRef.current = true;
        setRefreshingRedemptionBaseline(true);
        try {
          const freshUser = await queryClient.fetchQuery({ queryKey: queryKeys.me, queryFn: api.getMe, staleTime: 0 });
          if (!freshUser) throw new Error('未登录');
          syncUser(freshUser);
          baselineCredits = freshUser.credits;
          abandonedUncertainRedemption.current = false;
        } catch {
          notify('无法刷新积分余额，请重试。', 'error');
          releaseRedemptionSubmission();
          return;
        } finally {
          refreshingRedemptionBaselineRef.current = false;
          setRefreshingRedemptionBaseline(false);
        }
      }
      redeemAttempt.current = { normalizedCode, key: crypto.randomUUID(), baselineCredits };
    }
    redeem.mutate(redeemAttempt.current);
  }

  if (!me.data) return <main className="p-8"><div className="h-64 animate-pulse rounded-[28px] bg-card" /></main>;
  const user = me.data;
  const avatarUrl = avatarPreviewUrl ?? (user.avatarUrl ? apiResourceUrl(user.avatarUrl) : undefined);
  const redemptionLocked = submittingRedemption || redeem.isPending || refreshingRedemptionBaseline;
  return (
    <main className="mx-auto w-full max-w-[1380px] p-4 md:p-6 xl:p-8">
      <header><p className="flex items-center gap-2 text-sm font-medium text-primary"><UserRound className="size-4" />ACCOUNT</p><h1 className="mt-2 text-3xl font-semibold tracking-[-.04em] md:text-4xl">个人中心</h1></header>
      <div className="mt-7 grid gap-5 xl:grid-cols-[.72fr_1.28fr]">
        <div className="space-y-5">
          <section className="rounded-[26px] border border-border bg-card p-6">
            <div className="flex items-center gap-4">{avatarUrl ? <img src={avatarUrl} alt="用户头像" className="size-16 rounded-2xl object-cover" /> : <span className="grid size-16 place-items-center rounded-2xl bg-primary text-2xl font-black text-primary-foreground">{user.username.slice(0, 1).toUpperCase()}</span>}<div><h2 className="text-xl font-semibold">{user.username}</h2><p className="mt-1 text-sm text-muted-foreground">{user.email}</p></div></div>
            <div className="mt-6 grid grid-cols-2 gap-3"><div className="rounded-2xl bg-background p-4"><p className="flex items-center gap-2 text-xs text-muted-foreground"><Coins className="size-4 text-primary" />可用积分</p><strong className="mt-2 block text-3xl">{user.credits.toLocaleString()}</strong></div><div className="rounded-2xl bg-background p-4"><p className="flex items-center gap-2 text-xs text-muted-foreground"><Shield className="size-4 text-violet-300" />当前套餐</p><strong className="mt-2 block text-base">{user.planName}</strong><p className="mt-1 text-xs text-muted-foreground">并发 {user.concurrency}</p></div></div>
            <Button type="button" variant="ghost" className="mt-5 text-muted-foreground" onClick={() => logout.mutate()}><LogOut />退出登录</Button>
          </section>
          <section className="rounded-[26px] border border-border bg-card p-6">
            <h2 className="flex items-center gap-2 text-lg font-semibold"><UserRound className="size-5 text-primary" />资料与安全</h2>
            <div className="mt-4 flex items-end gap-3"><label className="grid size-14 shrink-0 cursor-pointer place-items-center overflow-hidden rounded-2xl border border-dashed border-border bg-background text-muted-foreground">{avatarUrl ? <img src={avatarUrl} alt="头像预览" className="size-full object-cover" /> : <Camera className="size-5" />}<input type="file" accept="image/*" aria-label="上传头像" className="sr-only" onChange={(event) => { const file = event.target.files?.[0]; if (file) selectAvatar(file); }} /></label><label className="flex-1 text-xs text-muted-foreground">用户名<Input aria-label="用户名" className="mt-1 h-10 bg-background text-foreground" value={username} onChange={(event) => setUsername(event.target.value)} /></label><Button type="button" size="icon" aria-label="保存个人资料" disabled={!username.trim() || profile.isPending} onClick={() => profile.mutate()}><Save /></Button></div>
            <div className="my-5 h-px bg-border" />
            <h3 className="flex items-center gap-2 text-sm font-semibold"><Mail className="size-4 text-primary" />更换登录邮箱</h3><div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto_110px_auto]"><Input aria-label="新邮箱" className="h-10 bg-background" value={email} onChange={(event) => setEmail(event.target.value)} /><Button type="button" variant="outline" aria-label="发送新邮箱验证码" disabled={!email.includes('@') || sendEmailCode.isPending} onClick={() => sendEmailCode.mutate()}>{sendEmailCode.isPending && <LoaderCircle className="animate-spin" />}发送验证码</Button><Input aria-label="邮箱验证码" className="h-10 bg-background" placeholder="验证码" value={emailCode} onChange={(event) => setEmailCode(event.target.value)} /><Button type="button" variant="secondary" disabled={!email.includes('@') || emailCode.length !== 6 || changeEmail.isPending} onClick={() => changeEmail.mutate()}>确认更换</Button></div>
            <div className="my-5 h-px bg-border" />
            <h3 className="flex items-center gap-2 text-sm font-semibold"><KeyRound className="size-4 text-primary" />修改密码</h3><div className="mt-3 grid gap-2 sm:grid-cols-[auto_110px_1fr_auto]"><Button type="button" variant="outline" aria-label="发送密码验证码" disabled={sendPasswordCode.isPending} onClick={() => sendPasswordCode.mutate(user.email)}>{sendPasswordCode.isPending && <LoaderCircle className="animate-spin" />}发送验证码</Button><Input aria-label="密码验证码" className="h-10 bg-background" placeholder="验证码" value={passwordCode} onChange={(event) => setPasswordCode(event.target.value)} /><Input aria-label="新密码" type="password" className="h-10 bg-background" placeholder="至少 12 位" value={password} onChange={(event) => setPassword(event.target.value)} /><Button type="button" variant="secondary" disabled={passwordCode.length !== 6 || password.length < 12 || changePassword.isPending} onClick={() => changePassword.mutate()}>更新密码</Button></div>
            <p className="mt-3 text-xs text-muted-foreground">验证码为 6 位，发送后请查收对应邮箱。</p>
          </section>
          <section className="rounded-[26px] border border-border bg-card p-6"><h2 className="flex items-center gap-2 text-lg font-semibold"><KeyRound className="size-5 text-primary" />兑换积分</h2><div className="mt-4 flex gap-2"><Input aria-label="兑换码" className="h-11 bg-background uppercase" value={code} disabled={redemptionLocked} onChange={(event) => { if (submittingRedemptionRef.current) return; if (redeemAttempt.current?.uncertain) abandonedUncertainRedemption.current = true; redeemAttempt.current = undefined; setCode(event.target.value); }} placeholder="输入兑换码" /><Button type="button" className="h-11 shrink-0" disabled={!code.trim() || redemptionLocked} onClick={redeemCredits}>{redemptionLocked && <LoaderCircle className="animate-spin" />}兑换积分</Button></div>{message && <p role="status" className={`mt-3 text-sm ${messageKind === 'success' ? 'text-primary' : 'text-destructive'}`}>{message}</p>}</section>
          <section className="rounded-[26px] border border-border bg-card p-6"><h2 className="text-lg font-semibold">邀请信息</h2><p className="mt-2 text-sm text-muted-foreground">每位好友注册后，双方获得奖励积分。</p><div className="mt-4 flex items-center justify-between rounded-xl bg-background p-3"><code className="text-sm text-primary">{user.inviteCode}</code><Button type="button" size="icon-sm" variant="ghost" aria-label="复制邀请码" onClick={() => navigator.clipboard?.writeText(user.inviteCode)}><Copy /></Button></div></section>
        </div>
        <section className="rounded-[26px] border border-border bg-card p-6"><div className="flex items-center justify-between"><div><h2 className="text-xl font-semibold">积分明细</h2><p className="mt-1 text-sm text-muted-foreground">冻结、消耗、退款和购买均可追溯。</p></div><span className="rounded-full bg-secondary px-3 py-1.5 text-xs text-muted-foreground">{ledger.data?.length ?? 0} 条</span></div><div className="mt-5"><PointLedger entries={ledger.data ?? []} /></div></section>
      </div>
    </main>
  );
}
