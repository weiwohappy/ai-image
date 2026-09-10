import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import AdminApp from './AdminApp';
import { actor, emptyTable, json } from './test/fixtures';
import { permissionEntries, roleOptions, teamActor } from './team/test-fixtures';

it('routes B1 team management to forms with the true super-administrator label', async () => {
  window.history.replaceState(null, '', '#/administrators');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.endsWith('/status'))
        return json({
          enabled: true,
          environment: 'development',
          stage: 'B1',
          teamWritesEnabled: true,
        });
      if (url.endsWith('/me')) return json(teamActor);
      if (url.endsWith('/team/permission-catalog'))
        return json({
          permissions: permissionEntries,
          assignableRoles: roleOptions,
          writeEnabled: true,
        });
      if (url.includes('/team/members'))
        return json({
          items: [],
          nextCursor: null,
          asOf: emptyTable.asOf,
          allowedActions: [{ action: 'create', allowed: true, reasonCode: null }],
        });
      return json(emptyTable);
    }),
  );
  render(<AdminApp />);
  expect(await screen.findByText('超级管理员')).toBeInTheDocument();
  expect(screen.getByText('development · 团队管理 B1')).toBeInTheDocument();
  expect(await screen.findByRole('button', { name: '新增成员' })).toBeEnabled();
  expect(screen.getByRole('tab', { name: '待激活邀请' })).toBeInTheDocument();
});

it('opens an anonymous reset link without showing a pre-existing account session', async () => {
  window.history.replaceState(
    null,
    '',
    '#/reset-password?token=' + 'a'.repeat(43) + '&email=lin%40example.test',
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.endsWith('/status')
        ? json({ enabled: true, environment: 'development', stage: 'B1' })
        : json(actor),
    ),
  );
  render(<AdminApp />);
  expect(window.location.hash).toBe('#/login');
  expect(await screen.findByRole('heading', { name: '设置新的登录密码' })).toBeInTheDocument();
  expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
});

it('does not use mock fallback when admin is disabled', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(json({ enabled: false, environment: 'test', stage: 'A' }));
  vi.stubGlobal('fetch', fetcher);
  render(<AdminApp />);
  await screen.findByRole('heading', { name: '管理入口尚未启用' });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(screen.queryByLabelText('密码')).not.toBeInTheDocument();
});
it('enters the console directly after an explicitly enabled local password login', async () => {
  window.history.replaceState(null, '', '#/login');
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve(
        url.endsWith('/status')
          ? json({
              enabled: true,
              environment: 'development',
              stage: 'A',
              localTestPasswords: true,
              localPasswordLogin: true,
            })
          : url.endsWith('/auth/login')
            ? json({ account: actor })
            : url.endsWith('/me')
              ? json(null, 401)
              : json({
                  asOf: emptyTable.asOf,
                  environment: 'development',
                  metrics: [],
                  alerts: emptyTable,
                  notices: [],
                }),
      ),
    ),
  );
  render(<AdminApp />);
  fireEvent.change(await screen.findByLabelText('工作邮箱'), { target: { value: actor.email } });
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: '登录' }));
  expect(await screen.findByRole('navigation')).toBeInTheDocument();
  expect(screen.queryByLabelText('六位动态验证码')).not.toBeInTheDocument();
  expect(screen.queryByText('保存一次性恢复码')).not.toBeInTheDocument();
});
it('refreshes a stale guest password policy on return without losing entered credentials', async () => {
  let localTestPasswords = false;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve(
        url.endsWith('/status')
          ? json({ enabled: true, environment: 'development', stage: 'A', localTestPasswords })
          : url.endsWith('/auth/login')
            ? json({ next: 'enroll', expiresAt: new Date(Date.now() + 300_000).toISOString() })
            : json(null, 401),
      ),
    ),
  );
  render(<AdminApp />);
  const password = await screen.findByLabelText('密码');
  expect(password).toHaveAttribute('minlength', '12');
  fireEvent.change(screen.getByLabelText('工作邮箱'), { target: { value: 'local@example.com' } });
  fireEvent.change(password, { target: { value: '123456' } });
  localTestPasswords = true;
  fireEvent.focus(window);
  await waitFor(() => expect(password).toHaveAttribute('minlength', '6'));
  expect(screen.getByLabelText('工作邮箱')).toHaveValue('local@example.com');
  expect(password).toHaveValue('123456');
  fireEvent.click(screen.getByRole('button', { name: /继续/ }));
  expect(await screen.findByRole('heading', { name: '绑定身份验证器' })).toBeInTheDocument();
  expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
});

it('removes the guest short-password exception when returning after it is disabled', async () => {
  let localTestPasswords = true;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve(
        url.endsWith('/status')
          ? json({ enabled: true, environment: 'development', stage: 'A', localTestPasswords })
          : json(null, 401),
      ),
    ),
  );
  render(<AdminApp />);
  const password = await screen.findByLabelText('密码');
  expect(password).toHaveAttribute('minlength', '6');
  localTestPasswords = false;
  fireEvent.focus(window);
  await waitFor(() => expect(password).toHaveAttribute('minlength', '12'));
});

it('hides guest login when a return-to-page status check reports administration disabled', async () => {
  let enabled = true;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve(
        url.endsWith('/status')
          ? json({ enabled, environment: 'development', stage: 'A' })
          : json(null, 401),
      ),
    ),
  );
  render(<AdminApp />);
  await screen.findByLabelText('密码');
  enabled = false;
  fireEvent.focus(window);
  expect(await screen.findByRole('heading', { name: '管理入口尚未启用' })).toBeInTheDocument();
  expect(screen.queryByLabelText('密码')).not.toBeInTheDocument();
});
it('clears protected pages when a read returns 401', async () => {
  window.history.replaceState(null, '', '#/users');
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve(
        url.endsWith('/status')
          ? json({ enabled: true, environment: 'test', stage: 'A' })
          : url.endsWith('/me')
            ? json(actor)
            : url.includes('/users')
              ? json(null, 401)
              : json({
                  asOf: emptyTable.asOf,
                  environment: 'test',
                  metrics: [],
                  alerts: emptyTable,
                  notices: [],
                }),
      ),
    ),
  );
  render(<AdminApp />);
  await screen.findByLabelText('密码');
  expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
});
it('clears the console immediately and revokes the server session on logout', async () => {
  window.history.replaceState(null, '', '#/dashboard');
  const fetcher = vi.fn((url: string) =>
    Promise.resolve(
      url.endsWith('/status')
        ? json({ enabled: true, environment: 'test', stage: 'A' })
        : url.endsWith('/me')
          ? json(actor)
          : url.endsWith('/auth/logout')
            ? json({ success: true })
            : json({
                asOf: emptyTable.asOf,
                environment: 'test',
                metrics: [],
                alerts: emptyTable,
                notices: [],
              }),
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  render(<AdminApp />);
  fireEvent.click(await screen.findByRole('button', { name: '退出登录' }));
  await screen.findByLabelText('密码');
  await waitFor(() =>
    expect(fetcher.mock.calls.some((call) => call[0].endsWith('/auth/logout'))).toBe(true),
  );
  expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
});
it('clears visible data after thirty minutes without interaction without background polling', async () => {
  vi.useFakeTimers();
  window.history.replaceState(null, '', '#/dashboard');
  const fetcher = vi.fn((url: string) =>
    Promise.resolve(
      url.endsWith('/status')
        ? json({ enabled: true, environment: 'test', stage: 'A' })
        : url.endsWith('/me')
          ? json(actor)
          : json({
              asOf: emptyTable.asOf,
              environment: 'test',
              metrics: [],
              alerts: emptyTable,
              notices: [],
            }),
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  await act(async () => {
    render(<AdminApp />);
  });
  expect(screen.getByRole('navigation')).toBeInTheDocument();
  const count = fetcher.mock.calls.length;
  await act(async () => {
    vi.advanceTimersByTime(30 * 60 * 1000 + 1);
  });
  expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  expect(screen.getByLabelText('密码')).toBeInTheDocument();
  expect(fetcher.mock.calls.length).toBe(count);
});

it('blocks login while a logout response could still clear new session cookies', async () => {
  window.history.replaceState(null, '', '#/dashboard');
  let finishLogout!: (value: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url.endsWith('/auth/logout'))
        return new Promise<Response>((resolve) => {
          finishLogout = resolve;
        });
      return Promise.resolve(
        url.endsWith('/status')
          ? json({ enabled: true, environment: 'test', stage: 'A' })
          : url.endsWith('/me')
            ? json(actor)
            : json({
                asOf: emptyTable.asOf,
                environment: 'test',
                metrics: [],
                alerts: emptyTable,
                notices: [],
              }),
      );
    }),
  );
  render(<AdminApp />);
  fireEvent.click(await screen.findByRole('button', { name: '退出登录' }));
  expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('密码')).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('正在退出');
  await act(async () => {
    finishLogout(json({ success: true }));
  });
  expect(await screen.findByLabelText('密码')).toBeInTheDocument();
});

it('clears and reloads role-scoped data even when the permission union is unchanged', async () => {
  window.history.replaceState(null, '', '#/dashboard');
  let currentActor = {
    ...actor,
    roles: ['support', 'model_operator'],
    permissions: [...actor.permissions, 'models.read', 'providers.read', 'costs.read'],
  };
  let finishNewDashboard!: (value: Response) => void;
  const dashboard = {
    asOf: emptyTable.asOf,
    environment: 'test',
    metrics: [],
    alerts: emptyTable,
    notices: ['old-role-only-data'],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url.endsWith('/status'))
        return Promise.resolve(json({ enabled: true, environment: 'test', stage: 'A' }));
      if (url.endsWith('/me')) return Promise.resolve(json(currentActor));
      if (currentActor.roles.includes('finance'))
        return new Promise<Response>((resolve) => {
          finishNewDashboard = resolve;
        });
      return Promise.resolve(json(dashboard));
    }),
  );
  render(<AdminApp />);
  await screen.findByText('old-role-only-data');
  currentActor = { ...currentActor, roles: ['finance', 'model_operator'] };
  fireEvent.focus(window);
  await waitFor(() => expect(screen.queryByText('old-role-only-data')).not.toBeInTheDocument());
  await act(async () => {
    finishNewDashboard(json({ ...dashboard, notices: ['new-role-data'] }));
  });
  expect(await screen.findByText('new-role-data')).toBeInTheDocument();
});
