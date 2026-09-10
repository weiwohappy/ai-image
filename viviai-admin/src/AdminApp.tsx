'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { AdminClient, AdminError, errorText } from './http';
import type { AdminActor, AdminStatus } from './contracts';
import { AuthScreen, Brand } from './AuthScreen';
import { ConsoleShell } from './ConsoleShell';

export default function AdminApp() {
  const [client] = useState(() => new AdminClient());
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [actor, setActor] = useState<AdminActor | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [logoutError, setLogoutError] = useState('');
  const [logoutPending, setLogoutPending] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    client.onUnauthorized = () => setActor(null);
    setLoading(true);
    setError('');
    (async () => {
      try {
        const next = await client.get<AdminStatus>('/status', controller.signal);
        if (controller.signal.aborted) return;
        setStatus(next);
        if (next.enabled) {
          try {
            const account = await client.get<AdminActor>('/me', controller.signal);
            if (!controller.signal.aborted) setActor(account);
          } catch (failure) {
            if (!(failure instanceof AdminError && failure.status === 401)) throw failure;
          }
        }
      } catch (failure) {
        if (!controller.signal.aborted) setError(errorText(failure));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => {
      controller.abort();
      client.onUnauthorized = undefined;
    };
  }, [client, retry]);
  useEffect(() => {
    if (loading || actor || logoutPending) return;
    let pending: AbortController | undefined;
    // An open login form can outlive a server configuration change.
    // Refresh on return without remounting the form or polling an idle session.
    async function refreshStatus() {
      pending?.abort();
      const controller = new AbortController();
      pending = controller;
      try {
        const next = await client.get<AdminStatus>('/status', controller.signal);
        if (!controller.signal.aborted) {
          setStatus(next);
          setError('');
        }
      } catch (failure) {
        if (!controller.signal.aborted) setError(errorText(failure));
      }
    }
    function visible() {
      if (document.visibilityState === 'visible') void refreshStatus();
    }
    window.addEventListener('focus', refreshStatus);
    document.addEventListener('visibilitychange', visible);
    return () => {
      pending?.abort();
      window.removeEventListener('focus', refreshStatus);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [actor, client, loading, logoutPending]);
  useEffect(() => {
    if (!actor) return;
    const controller = new AbortController();
    const delay = new Date(actor.sessionExpiresAt).getTime() - Date.now();
    const timer = setTimeout(
      () => {
        client.invalidate();
        setActor(null);
      },
      Math.max(0, Math.min(delay, 8 * 60 * 60 * 1000)),
    );
    let idleTimer: ReturnType<typeof setTimeout>;
    function activity() {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => {
          client.invalidate();
          setActor(null);
        },
        30 * 60 * 1000,
      );
    }
    activity();
    window.addEventListener('pointerdown', activity);
    window.addEventListener('keydown', activity);
    // Revalidate when returning to the app, never poll to keep an idle session alive.
    async function focus() {
      try {
        const next = await client.get<AdminActor>('/me', controller.signal);
        if (!controller.signal.aborted) {
          if (authContext(next) !== authContext(actor!)) client.invalidate();
          setActor(next);
        }
      } catch {
        if (!controller.signal.aborted) {
          client.invalidate();
          setActor(null);
        }
      }
    }
    window.addEventListener('focus', focus);
    return () => {
      controller.abort();
      clearTimeout(timer);
      clearTimeout(idleTimer);
      window.removeEventListener('focus', focus);
      window.removeEventListener('pointerdown', activity);
      window.removeEventListener('keydown', activity);
    };
  }, [actor, client]);
  async function logout() {
    if (logoutPending) return;
    setLogoutPending(true);
    // Hide cached UI before waiting for network, but report a failed server revocation.
    client.invalidate();
    setActor(null);
    setLogoutError('');
    window.history.replaceState(null, '', '#/login');
    try {
      await client.post('/auth/logout', {}, undefined, false);
    } catch {
      setLogoutError('本页内容已清除，但服务端会话撤销未确认。请重试退出；不要直接离开共享设备。');
    } finally {
      setLogoutPending(false);
    }
  }
  if (loading || error || !status?.enabled)
    return (
      <div className="auth-layout">
        <header className="auth-header">
          <Brand />
          <span className="environment">安全查询台 A</span>
        </header>
        <main className="auth-card">
          <p className="eyebrow">OPERATIONS CONSOLE</p>
          <h1>{loading ? '正在连接管理服务' : error ? '管理服务未连接' : '管理入口尚未启用'}</h1>
          <p className="muted" role={error ? 'alert' : 'status'}>
            {loading
              ? '正在检查环境和独立管理员会话…'
              : error ||
                '此入口默认关闭。请先配置后端管理模块，并通过离线流程邀请两位初始管理员。这里没有默认账号。'}
          </p>
          {!loading && <Button onClick={() => setRetry((value) => value + 1)}>重新检查连接</Button>}
          <div className="auth-note">没有模拟数据，也不会回退到用户端登录。</div>
        </main>
      </div>
    );
  if (logoutPending)
    return (
      <div className="auth-layout">
        <header className="auth-header">
          <Brand />
        </header>
        <main className="auth-card" role="status">
          <h1>正在退出登录</h1>
          <p className="muted">正在撤销服务端会话，请稍候…</p>
        </main>
      </div>
    );
  if (!actor)
    return (
      <>
        {logoutError && (
          <div className="error-banner" role="alert">
            {logoutError}
            <Button variant="outline" onClick={logout}>
              重试退出
            </Button>
          </div>
        )}
        <AuthScreen
          client={client}
          environment={status.environment}
          localTestPasswords={status.localTestPasswords === true}
          localPasswordLogin={status.localPasswordLogin === true}
          onSuccess={(account) => {
            client.invalidate();
            setLogoutError('');
            setActor(account);
          }}
        />
      </>
    );
  return (
    <ConsoleShell
      key={authContext(actor)}
      actor={actor}
      client={client}
      environment={status.environment}
      onLogout={logout}
    />
  );
}

function authContext(actor: AdminActor) {
  return JSON.stringify([actor.id, actor.roles.slice().sort(), actor.permissions.slice().sort()]);
}
