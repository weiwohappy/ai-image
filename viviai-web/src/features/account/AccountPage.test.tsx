import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { resetDb } from '@/src/mocks/db';
import { server } from '@/src/mocks/server';
import { AccountPage } from './AccountPage';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => resetDb());
afterEach(() => cleanup());
afterAll(() => server.close());

describe('account page', () => {
  it('redeems a valid demo code and refreshes the balance', async () => {
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><MemoryRouter><AccountPage /></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByText('1,120')).toBeVisible();
    await user.type(screen.getByLabelText('兑换码'), 'VIVIAI2026');
    await user.click(screen.getByRole('button', { name: '兑换积分' }));
    expect(await screen.findByText('1,220')).toBeVisible();
  });

  it('clears private query data when the user logs out', async () => {
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['assets'], [{ id: 'private-asset' }]);
    render(<QueryClientProvider client={client}><MemoryRouter><AccountPage /></MemoryRouter></QueryClientProvider>);
    await user.click(await screen.findByRole('button', { name: '退出登录' }));
    await waitFor(() => expect(client.getQueryData(['assets'])).toBeUndefined());
  });

  it('keeps account commands available when the real API is configured', async () => {
    vi.stubEnv('VITE_API_MODE', 'real');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><MemoryRouter><AccountPage /></MemoryRouter></QueryClientProvider>);

    expect(await screen.findByRole('button', { name: '保存个人资料' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '发送新邮箱验证码' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '发送密码验证码' })).toBeEnabled();
    expect(screen.getByLabelText('兑换码')).toBeVisible();
  });
});
