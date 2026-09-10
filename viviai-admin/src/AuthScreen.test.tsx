import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { it, expect, vi } from 'vitest';
import { AuthScreen } from './AuthScreen';
import { AdminClient } from './http';
import { actor, json } from './test/fixtures';

it('accepts an invite, removes its URL token, verifies MFA, and requires recovery acknowledgement', async () => {
  window.history.replaceState(null, '', '#/accept?token=invite-token');
  const done = vi.fn();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      json({
        next: 'enroll',
        secret: 'TESTSECRET',
        otpauthUri: 'otpauth://totp/test?secret=TESTSECRET',
        expiresAt: '2099-01-01T00:00:00Z',
      }),
    )
    .mockResolvedValueOnce(json({ account: actor, recoveryCodes: ['one-time-code'] }));
  vi.stubGlobal('fetch', fetcher);
  render(<AuthScreen client={new AdminClient()} onSuccess={done} environment="test" />);
  fireEvent.change(screen.getByLabelText('工作邮箱'), { target: { value: actor.email } });
  fireEvent.change(screen.getByLabelText('姓名'), { target: { value: '值班同事' } });
  fireEvent.change(screen.getByLabelText('设置密码'), { target: { value: 'secure-password-123' } });
  fireEvent.click(screen.getByRole('button', { name: '接受邀请并绑定验证器' }));
  expect(await screen.findByText('TESTSECRET')).toBeInTheDocument();
  expect(window.location.hash).toBe('#/login');
  fireEvent.change(screen.getByLabelText('六位动态验证码'), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: '验证并登录' }));
  expect(await screen.findByText('one-time-code')).toBeInTheDocument();
  expect(done).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText('我已将恢复码保存到安全位置'));
  fireEvent.click(screen.getByRole('button', { name: '进入工作台' }));
  expect(done).toHaveBeenCalledWith(actor);
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
});

it('does not grant a console session before MFA and permits recovery login only after password proof', async () => {
  window.history.replaceState(null, '', '#/login');
  const done = vi.fn();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(json({ next: 'mfa', expiresAt: '2099-01-01T00:00:00Z' }))
    .mockResolvedValueOnce(json({ account: actor }));
  vi.stubGlobal('fetch', fetcher);
  render(<AuthScreen client={new AdminClient()} onSuccess={done} environment="test" />);
  fireEvent.change(screen.getByLabelText('工作邮箱'), { target: { value: actor.email } });
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secure-password-123' } });
  fireEvent.click(screen.getByRole('button', { name: '继续验证' }));
  await screen.findByLabelText('六位动态验证码');
  expect(done).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '使用恢复码' }));
  fireEvent.change(screen.getByLabelText('一次性恢复码'), { target: { value: 'recovery-code' } });
  fireEvent.click(screen.getByRole('button', { name: '验证并登录' }));
  await waitFor(() => expect(done).toHaveBeenCalledWith(actor));
  expect(fetcher.mock.calls[1][1].body).toBe(
    JSON.stringify({ method: 'recovery', code: 'recovery-code' }),
  );
});

it('clears an expired enrollment secret and does not expose a recovery option during setup', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-09T00:00:00Z'));
  window.history.replaceState(null, '', '#/login');
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        json({ next: 'enroll', secret: 'ephemeral-secret', expiresAt: '2026-09-09T00:00:01Z' }),
      ),
  );
  render(<AuthScreen client={new AdminClient()} environment="test" onSuccess={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('工作邮箱'), { target: { value: actor.email } });
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secure-password-123' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '继续验证' }));
  });
  expect(screen.getByText('ephemeral-secret')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '使用恢复码' })).not.toBeInTheDocument();
  await act(async () => {
    vi.advanceTimersByTime(1001);
  });
  expect(screen.queryByText('ephemeral-secret')).not.toBeInTheDocument();
  expect(screen.getByLabelText('密码')).toHaveValue('');
});

it('recognizes an invitation opened in an already mounted logged-out tab', () => {
  window.history.replaceState(null, '', '#/login');
  render(<AuthScreen client={new AdminClient()} environment="test" onSuccess={vi.fn()} />);
  act(() => {
    window.history.replaceState(null, '', '#/accept?token=new-invitation');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  expect(screen.getByRole('button', { name: '接受邀请并绑定验证器' })).toBeInTheDocument();
});

it('allows the native short-password form only in explicit development mode and still proceeds to MFA', async () => {
  window.history.replaceState(null, '', '#/login');
  const done = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        json({ next: 'enroll', secret: 'LOCAL_TEST_SECRET', expiresAt: '2099-01-01T00:00:00Z' }),
      ),
  );
  render(
    <AuthScreen
      client={new AdminClient()}
      onSuccess={done}
      environment="development"
      localTestPasswords
    />,
  );
  expect(screen.getByLabelText('密码')).toHaveAttribute('minlength', '6');
  fireEvent.change(screen.getByLabelText('工作邮箱'), { target: { value: actor.email } });
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: '继续验证' }));
  expect(await screen.findByText('LOCAL_TEST_SECRET')).toBeInTheDocument();
  expect(done).not.toHaveBeenCalled();
});

it.each([
  ['development', false],
  ['production', true],
  ['test', true],
])(
  'keeps the standard password requirement in %s without a valid local exception',
  (environment, localTestPasswords) => {
    window.history.replaceState(null, '', '#/login');
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    render(
      <AuthScreen
        client={new AdminClient()}
        onSuccess={vi.fn()}
        environment={environment as string}
        localTestPasswords={localTestPasswords as boolean}
      />,
    );
    expect(screen.getByLabelText('密码')).toHaveAttribute('minlength', '12');
    fireEvent.change(screen.getByLabelText('工作邮箱'), { target: { value: actor.email } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: '123456' } });
    fireEvent.submit(screen.getByRole('button', { name: '继续验证' }).closest('form')!);
    expect(screen.getByRole('alert')).toHaveTextContent('12');
    expect(fetcher).not.toHaveBeenCalled();
  },
);
