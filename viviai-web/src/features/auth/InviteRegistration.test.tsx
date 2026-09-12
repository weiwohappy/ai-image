import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { api } from '@/src/services/api';
import { AuthPage } from './AuthPage';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('invite registration', () => {
  it('forwards a normalized valid invite code with registration', async () => {
    const register = vi.spyOn(api, 'register').mockResolvedValue({
      id: 'user-1', username: 'creator', email: 'creator@example.com', planId: 'free', planName: 'Free', credits: 0, frozenCredits: 0, concurrency: 1, inviteCode: 'CREATOR-1',
    });
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/register?invite= vivi-2026 ']}><AuthPage mode="register" /></MemoryRouter></QueryClientProvider>);

    await user.type(screen.getByLabelText('用户名'), 'creator');
    await user.type(screen.getByLabelText('邮箱'), 'creator@example.com');
    await user.type(screen.getByLabelText('验证码'), '123456');
    await user.type(screen.getByLabelText('密码'), 'password-1234');
    await user.type(screen.getByLabelText('确认密码'), 'password-1234');
    await user.click(screen.getByRole('button', { name: '注册并登录' }));

    expect(register).toHaveBeenCalledWith({
      username: 'creator', email: 'creator@example.com', password: 'password-1234', code: '123456', inviteCode: 'VIVI-2026',
    });
  });

  it('does not forward an invalid invite code', async () => {
    const register = vi.spyOn(api, 'register').mockResolvedValue({
      id: 'user-1', username: 'creator', email: 'creator@example.com', planId: 'free', planName: 'Free', credits: 0, frozenCredits: 0, concurrency: 1, inviteCode: 'CREATOR-1',
    });
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/register?invite=not_valid!']}><AuthPage mode="register" /></MemoryRouter></QueryClientProvider>);

    await user.type(screen.getByLabelText('用户名'), 'creator');
    await user.type(screen.getByLabelText('邮箱'), 'creator@example.com');
    await user.type(screen.getByLabelText('验证码'), '123456');
    await user.type(screen.getByLabelText('密码'), 'password-1234');
    await user.type(screen.getByLabelText('确认密码'), 'password-1234');
    await user.click(screen.getByRole('button', { name: '注册并登录' }));

    expect(register).toHaveBeenCalledWith({
      username: 'creator', email: 'creator@example.com', password: 'password-1234', code: '123456',
    });
  });
});
