import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { AuthScreen } from './AuthScreen';
import { AdminClient } from './http';
import { json } from './test/fixtures';
import { readAuthLink } from './auth-link';

it.each([
  '#/other?token=' + 'a'.repeat(43),
  '#/accept?token=' + 'a'.repeat(43) + '&token=' + 'b'.repeat(43),
  '#/accept?token=' + 'a'.repeat(42),
  '#/reset-password?token=' + 'a'.repeat(43) + '&email=mail%0Ainjected',
])('rejects malformed or ambiguous link %s', (hash) => {
  expect(readAuthLink(hash)).toBeNull();
});

it('shows a malformed-link warning when navigating from a mounted local login', () => {
  window.history.replaceState(null, '', '#/login');
  render(
    <AuthScreen
      client={new AdminClient()}
      onSuccess={vi.fn()}
      environment="development"
      localTestPasswords
      localPasswordLogin
    />,
  );
  act(() => {
    window.history.replaceState(null, '', '#/accept?token=bad');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  expect(screen.getByRole('alert')).toHaveTextContent('链接格式无效');
});

it('immediately scrubs invitation secrets and prefills nonauthoritative identity without issuing a request', () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  window.history.replaceState(
    null,
    '',
    '#/accept?token=' + 'a'.repeat(43) + '&email=lin%40example.test&displayName=Lin',
  );
  render(<AuthScreen client={new AdminClient()} onSuccess={vi.fn()} environment="development" />);
  expect(window.location.hash).toBe('#/login');
  expect(screen.getByLabelText('工作邮箱')).toHaveValue('lin@example.test');
  expect(screen.getByLabelText('姓名')).toHaveValue('Lin');
  expect(fetcher).not.toHaveBeenCalled();
  expect(localStorage.length + sessionStorage.length).toBe(0);
});

it('accepts a reset link without a session, validates repeated password and returns to login', async () => {
  const token = 'b'.repeat(43);
  const done = vi.fn();
  window.history.replaceState(null, '', `#/reset-password?token=${token}&email=lin%40example.test`);
  const fetcher = vi.fn().mockResolvedValue(json({ success: true }, 201));
  vi.stubGlobal('fetch', fetcher);
  render(
    <AuthScreen
      client={new AdminClient()}
      onSuccess={done}
      environment="development"
      localTestPasswords
      localPasswordLogin
    />,
  );
  expect(window.location.hash).toBe('#/login');
  expect(screen.getByLabelText('工作邮箱')).toHaveValue('lin@example.test');
  fireEvent.change(screen.getByLabelText('新密码'), { target: { value: 'secure-password-123' } });
  fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: 'not-matching-123' } });
  fireEvent.click(screen.getByRole('button', { name: '重置密码' }));
  expect(screen.getByRole('alert')).toHaveTextContent('两次密码不一致');
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('确认新密码'), {
    target: { value: 'secure-password-123' },
  });
  fireEvent.click(screen.getByRole('button', { name: '重置密码' }));
  await screen.findByText('密码已重置');
  expect(fetcher.mock.calls[0][0]).toBe('/api/admin/auth/password-resets/accept');
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
    token,
    email: 'lin@example.test',
    password: 'secure-password-123',
  });
  expect(done).not.toHaveBeenCalled();
  expect(screen.queryByLabelText('新密码')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '返回登录' }));
  expect(screen.getByRole('heading', { name: '登录运营工作台' })).toBeInTheDocument();
  expect(screen.getByLabelText('密码')).toHaveValue('');
});

it('scrubs malformed known auth links but never treats them as a credential', () => {
  window.history.replaceState(null, '', '#/reset-password?token=invalid-secret');
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  render(<AuthScreen client={new AdminClient()} onSuccess={vi.fn()} environment="test" />);
  expect(window.location.hash).toBe('#/login');
  expect(screen.getByRole('alert')).toHaveTextContent('链接格式无效');
  expect(fetcher).not.toHaveBeenCalled();
});

it('recognizes a reset link in an already mounted guest form and masks invalid-reset server detail', async () => {
  window.history.replaceState(null, '', '#/login');
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            data: null,
            code: 'ADMIN_INVALID_RESET',
            message: 'raw-secret',
            requestId: 'test',
          }),
          { status: 400 },
        ),
    ),
  );
  render(<AuthScreen client={new AdminClient()} onSuccess={vi.fn()} environment="test" />);
  act(() => {
    window.history.replaceState(
      null,
      '',
      '#/reset-password?token=' + 'r'.repeat(43) + '&email=a%40example.test',
    );
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  fireEvent.change(screen.getByLabelText('新密码'), { target: { value: 'secure-password-123' } });
  fireEvent.change(screen.getByLabelText('确认新密码'), {
    target: { value: 'secure-password-123' },
  });
  fireEvent.click(screen.getByRole('button', { name: '重置密码' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('重置链接无效'));
  expect(document.body.textContent).not.toContain('raw-secret');
});
