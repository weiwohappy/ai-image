import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AdminClient, AdminError, errorText } from '../http';
import type { AuthLink } from './auth-link';
import { reasonText } from './presentation';
import { FieldErrorsProvider, FormField, type FieldErrors } from './FormField';

export function PasswordResetScreen({
  link,
  client,
  onDone,
  localTestPasswords,
  environment,
}: {
  link: AuthLink;
  client: AdminClient;
  onDone: () => void;
  localTestPasswords: boolean;
  environment: string;
}) {
  const [token, setToken] = useState(link.token);
  const [email, setEmail] = useState(link.email);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [success, setSuccess] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current || success) return;
    // The global flag does not prove this anonymous link belongs to an allowlisted account.
    const min = 12;
    const invalid: FieldErrors = {};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) invalid.email = '请填写有效的工作邮箱';
    if (password.length < min || password.length > 128) {
      invalid.password = `密码需为 ${min}–128 个字符`;
    }
    if (password !== repeat) {
      invalid.repeat = '两次密码不一致';
    }
    setFieldErrors(invalid);
    if (Object.keys(invalid).length) {
      setError(Object.values(invalid).join('；'));
      return;
    }
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    try {
      const result = await client.post<{ success: boolean }>(
        '/auth/password-resets/accept',
        { token, email: email.trim().toLowerCase(), password },
        controller.signal,
        false,
      );
      if (controller.signal.aborted) return;
      if (result.success !== true) throw new AdminError(502);
      setToken('');
      setPassword('');
      setRepeat('');
      setSuccess(true);
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(
          failure instanceof AdminError && failure.code === 'ADMIN_INVALID_RESET'
            ? reasonText(failure.code)
            : errorText(failure),
        );
    } finally {
      if (!controller.signal.aborted) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <div className="auth-layout">
      <main className="auth-card">
        <p className="eyebrow">VIVIAI / ACCOUNT RECOVERY</p>
        {environment === 'development' && localTestPasswords && (
          <p className="caption">匿名重置统一要求至少 12 位；不会修改现有账号的本机登录例外。</p>
        )}
        <h1>{success ? '密码已重置' : '设置新的登录密码'}</h1>
        {success ? (
          <div className="stack">
            <p className="muted">请使用新密码重新登录。原有身份验证器仍然有效。</p>
            <Button onClick={onDone}>返回登录</Button>
          </div>
        ) : (
          <form className="stack" noValidate onSubmit={submit}>
            <p className="muted">链接仅能使用一次，有效期 30 分钟。重置密码不会解除身份验证器。</p>
            <FieldErrorsProvider value={fieldErrors}>
              <fieldset className="team-fields" disabled={busy}>
                <FormField name="email" label="工作邮箱">
                  <Input
                    type="email"
                    autoComplete="username"
                    required
                    value={email}
                    maxLength={254}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </FormField>
                <FormField name="password" label="新密码">
                  <Input
                    type="password"
                    autoComplete="new-password"
                    required
                    maxLength={128}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </FormField>
                <FormField name="repeat" label="确认新密码">
                  <Input
                    type="password"
                    autoComplete="new-password"
                    required
                    maxLength={128}
                    value={repeat}
                    onChange={(e) => setRepeat(e.target.value)}
                  />
                </FormField>
              </fieldset>
            </FieldErrorsProvider>
            {error && (
              <p className="error-banner" role="alert">
                {error}
              </p>
            )}
            <Button type="submit" disabled={busy}>
              {busy ? '正在重置…' : '重置密码'}
            </Button>
            <Button type="button" variant="outline" disabled={busy} onClick={onDone}>
              返回登录
            </Button>
          </form>
        )}
      </main>
    </div>
  );
}
