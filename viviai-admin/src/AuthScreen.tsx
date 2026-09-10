'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { ShieldCheck, ArrowRight, LockKeyhole } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { AdminClient, errorText } from './http';
import type { AdminActor, AuthChallenge, AuthResult } from './contracts';

export function AuthScreen({
  client,
  onSuccess,
  environment,
  localTestPasswords = false,
  localPasswordLogin = false,
}: {
  client: AdminClient;
  onSuccess: (actor: AdminActor) => void;
  environment: string;
  localTestPasswords?: boolean;
  localPasswordLogin?: boolean;
}) {
  const localPasswordMode = environment === 'development' && localTestPasswords;
  const passwordOnlyMode = localPasswordMode && localPasswordLogin;
  const minimumPasswordLength = localPasswordMode ? 6 : 12;
  const [token, setToken] = useState(() =>
    typeof window !== 'undefined' && window.location.hash.startsWith('#/accept?')
      ? (new URLSearchParams(window.location.hash.split('?')[1]).get('token') ?? '')
      : '',
  );
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<AuthChallenge | null>(null);
  const [method, setMethod] = useState<'totp' | 'recovery'>('totp');
  const [result, setResult] = useState<AuthResult | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    if (!passwordOnlyMode) return;
    // A local policy change can arrive while the old enrollment screen is open.
    pending.current?.abort();
    setChallenge(null);
    setCode('');
    setBusy(false);
    setError('');
  }, [passwordOnlyMode]);
  useEffect(() => {
    function changed() {
      pending.current?.abort();
      setToken(
        window.location.hash.startsWith('#/accept?')
          ? (new URLSearchParams(window.location.hash.split('?')[1]).get('token') ?? '')
          : '',
      );
      setPassword('');
      setCode('');
      setChallenge(null);
      setResult(null);
      setSaved(false);
      setBusy(false);
      setError('');
    }
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  useEffect(() => {
    if (!challenge) return;
    const expires = new Date(challenge.expiresAt).getTime();
    const remaining = expires - Date.now();
    if (!Number.isFinite(remaining)) {
      setChallenge(null);
      return;
    }
    // Clamp the timer to avoid overflow from malformed dates.
    const timer = setTimeout(
      () => {
        pending.current?.abort();
        setChallenge(null);
        setCode('');
        setBusy(false);
        setError('验证已过期，请重新输入邮箱和密码');
      },
      Math.max(0, Math.min(remaining, 600_000)),
    );
    return () => clearTimeout(timer);
  }, [challenge]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError('');
    if (!challenge && (password.length < minimumPasswordLength || password.length > 128)) {
      setError(`密码需为 ${minimumPasswordLength}–128 个字符`);
      return;
    }
    setBusy(true);
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    try {
      if (!challenge) {
        const data = token ? { token, email, displayName, password } : { email, password };
        const next = await client.post<AuthChallenge | AuthResult>(
          token ? '/auth/invitations/accept' : '/auth/login',
          data,
          controller.signal,
          false,
        );
        if (controller.signal.aborted) return;
        setPassword('');
        setCode('');
        setMethod('totp');
        if (token) {
          setToken('');
          window.history.replaceState(
            null,
            '',
            `${window.location.pathname}${window.location.search}#/login`,
          );
        }
        if ('account' in next) {
          onSuccess(next.account);
          return;
        }
        setChallenge(next);
      } else {
        const next = await client.post<AuthResult>(
          '/auth/mfa/verify',
          { method, code },
          controller.signal,
          false,
        );
        if (controller.signal.aborted) return;
        setChallenge(null);
        setCode('');
        if (next.recoveryCodes?.length) setResult(next);
        else onSuccess(next.account);
      }
    } catch (failure) {
      if (!controller.signal.aborted) setError(errorText(failure));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <div className="auth-layout">
      <header className="auth-header">
        <Brand />
        <span className="environment">{environment} · 内部团队</span>
      </header>
      <main className="auth-card" aria-labelledby="auth-title">
        <div className="auth-icon">
          <LockKeyhole size={24} />
        </div>
        <p className="eyebrow">OPERATIONS CONSOLE</p>
        <h1 id="auth-title">
          {result
            ? '保存一次性恢复码'
            : challenge
              ? challenge.next === 'enroll'
                ? '绑定身份验证器'
                : '完成身份验证'
              : token
                ? '激活团队邀请'
                : '登录运营工作台'}
        </h1>
        <p className="muted">
          {result
            ? '恢复码仅展示这一次。无法使用验证器时，每个恢复码可登录一次。'
            : challenge
              ? '管理员必须完成双重验证。请勿将密钥或恢复码发送给他人。'
              : '仅受邀内部成员可访问。用户端账号不能登录此工作台。'}
        </p>
        {error && (
          <p role="alert" className="error-banner">
            {error}
          </p>
        )}
        {result ? (
          <div className="stack">
            <ul className="recovery-codes">
              {result.recoveryCodes?.map((value) => (
                <li key={value}>
                  <code>{value}</code>
                </li>
              ))}
            </ul>
            <label className="check-label">
              <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
              我已将恢复码保存到安全位置
            </label>
            <Button
              className="primary-action"
              disabled={!saved}
              onClick={() => {
                const account = result.account;
                setResult(null);
                setSaved(false);
                onSuccess(account);
              }}
            >
              进入工作台
              <ArrowRight />
            </Button>
          </div>
        ) : (
          <form onSubmit={submit} className="stack">
            {!challenge ? (
              <>
                <label className="field">
                  工作邮箱
                  <Input
                    type="email"
                    autoComplete="username"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="name@company.com"
                  />
                </label>
                {token && (
                  <label className="field">
                    姓名
                    <Input
                      autoComplete="name"
                      required
                      maxLength={80}
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                    />
                  </label>
                )}
                <label className="field">
                  {token ? '设置密码' : '密码'}
                  <Input
                    type="password"
                    autoComplete={token ? 'new-password' : 'current-password'}
                    required
                    minLength={minimumPasswordLength}
                    maxLength={128}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </label>
                {localPasswordMode ? (
                  <p className="caption">
                    {passwordOnlyMode
                      ? '本机测试：指定账号可直接使用邮箱和密码登录。其他账号仍需双重验证；请勿用于正式环境。'
                      : '仅预先授权的本机测试账号允许临时短密码，仍需双重验证。其他账号至少 12 位；请勿用于正式环境。'}
                  </p>
                ) : (
                  token && (
                    <p className="caption">
                      密码需为 12–128 个字符。邀请与指定邮箱绑定，不可转让。
                    </p>
                  )
                )}
              </>
            ) : (
              <>
                {challenge.next === 'enroll' && (
                  <div className="enrollment">
                    {challenge.otpauthUri && (
                      <QRCodeSVG value={challenge.otpauthUri} size={160} title="验证器绑定二维码" />
                    )}
                    <p className="caption">使用身份验证器扫描二维码，或手动输入密钥：</p>
                    <code className="manual-secret">{challenge.secret}</code>
                  </div>
                )}
                {method === 'totp' ? (
                  <div className="field">
                    <label htmlFor="totp-code">六位动态验证码</label>
                    <InputOTP
                      id="totp-code"
                      aria-label="六位动态验证码"
                      maxLength={6}
                      pattern="^[0-9]*$"
                      value={code}
                      onChange={setCode}
                      autoComplete="one-time-code"
                    >
                      <InputOTPGroup>
                        {Array.from({ length: 6 }, (_, index) => (
                          <InputOTPSlot key={index} index={index} />
                        ))}
                      </InputOTPGroup>
                    </InputOTP>
                  </div>
                ) : (
                  <label className="field">
                    一次性恢复码
                    <Input
                      autoComplete="off"
                      required
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      maxLength={128}
                    />
                  </label>
                )}
                {challenge.next === 'mfa' && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setMethod(method === 'totp' ? 'recovery' : 'totp');
                      setCode('');
                    }}
                  >
                    {method === 'totp' ? '使用恢复码' : '使用动态验证码'}
                  </Button>
                )}
              </>
            )}
            <Button
              type="submit"
              className="primary-action"
              disabled={
                busy || (!!challenge && (method === 'totp' ? !/^\d{6}$/.test(code) : !code.trim()))
              }
            >
              {busy
                ? '正在验证…'
                : challenge
                  ? '验证并登录'
                  : token
                    ? passwordOnlyMode
                      ? '接受邀请并登录'
                      : '接受邀请并绑定验证器'
                    : passwordOnlyMode
                      ? '登录'
                      : '继续验证'}
              {!busy && <ArrowRight />}
            </Button>
            {challenge && (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setChallenge(null);
                  setCode('');
                  setError('');
                }}
              >
                返回密码登录
              </Button>
            )}
          </form>
        )}
        <div className="auth-note">
          <ShieldCheck size={16} />
          <span>
            {passwordOnlyMode
              ? '本机测试 · 密码登录 · 访问留痕'
              : '独立管理员身份 · 双重验证 · 访问留痕'}
          </span>
        </div>
      </main>
      <footer className="auth-footer">
        VIVIAI · 安全查询台 A <span>没有邀请？请联系团队系统管理员。</span>
      </footer>
    </div>
  );
}
export function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">V</span>
      <span>
        VIVIAI <small>运营平台</small>
      </span>
    </div>
  );
}
