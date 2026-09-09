import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import AdminApp from './AdminApp';
import { actor, emptyTable, json } from './test/fixtures';

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
