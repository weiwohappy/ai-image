import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { mutateDb, resetDb } from '@/src/mocks/db';
import { server } from '@/src/mocks/server';
import { api, ApiError } from '@/src/services/api';
import { AccountPage } from './AccountPage';

function NotificationCount() {
  const notices = useQuery({ queryKey: ['notifications'], queryFn: api.listNotifications });
  return <span>未读 {notices.data?.filter((item) => !item.read).length ?? 0}</span>;
}

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => resetDb());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
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

  it('renders authoritative relative avatar paths on the configured API origin', async () => {
    vi.stubEnv('VITE_API_MODE', 'real');
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.test/service');
    mutateDb((draft) => { draft.user.avatarUrl = '/api/assets/avatar-1/content'; });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><MemoryRouter><AccountPage /></MemoryRouter></QueryClientProvider>);

    expect((await screen.findByAltText('用户头像')).getAttribute('src')).toBe('https://api.example.test/service/api/assets/avatar-1/content');
  });

  it('keeps the saved username when avatar upload fails after profile save', async () => {
    const updated = { id: 'user-demo', username: 'updated_name', email: 'demo@viviai.local', planId: 'plan-pro-month', planName: '专业版月卡', credits: 1120, frozenCredits: 0, concurrency: 8, inviteCode: 'VIVI-MIA88' };
    vi.spyOn(api, 'updateProfile').mockResolvedValue(updated);
    vi.spyOn(api, 'uploadAvatar').mockRejectedValue(new ApiError('头像上传失败', 'ASSET_INVALID', 400));
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:avatar-preview') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><MemoryRouter><AccountPage /></MemoryRouter></QueryClientProvider>);
    await screen.findByText('Mia Chen');
    await user.clear(screen.getByLabelText('用户名'));
    await user.type(screen.getByLabelText('用户名'), 'updated_name');
    await user.upload(screen.getByLabelText('上传头像'), new File(['avatar'], 'avatar.png', { type: 'image/png' }));
    await user.click(screen.getByRole('button', { name: '保存个人资料' }));

    expect(await screen.findByText('用户名已保存，但头像上传失败。')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'updated_name' })).toBeVisible();
  });

  it('refreshes account, ledger, and notifications after redemption', async () => {
    const invalidate = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(client, 'invalidateQueries').mockImplementation(invalidate);
    vi.spyOn(api, 'redeemCode').mockResolvedValue({ id: 'user-demo', username: 'Mia Chen', email: 'demo@viviai.local', planId: 'plan-pro-month', planName: '专业版月卡', credits: 1220, frozenCredits: 0, concurrency: 8, inviteCode: 'VIVI-MIA88' });
    const user = userEvent.setup();
    render(<QueryClientProvider client={client}><MemoryRouter><AccountPage /></MemoryRouter></QueryClientProvider>);
    await user.type(await screen.findByLabelText('兑换码'), 'VIVIAI2026');
    await user.click(screen.getByRole('button', { name: '兑换积分' }));

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['me'] }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['point-ledger'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['notifications'] });
  });

  it('starts a new redemption attempt after a definitive 4xx rejection', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce('attempt-key-0001').mockReturnValueOnce('attempt-key-0002');
    const redeemCode = vi.spyOn(api, 'redeemCode').mockRejectedValueOnce(new ApiError('兑换码无效', 'REDEMPTION_INVALID_OR_EXPIRED', 422)).mockResolvedValueOnce({ id: 'user-demo', username: 'Mia Chen', email: 'demo@viviai.local', planId: 'plan-pro-month', planName: '专业版月卡', credits: 1220, frozenCredits: 0, concurrency: 8, inviteCode: 'VIVI-MIA88' });
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><MemoryRouter><AccountPage /></MemoryRouter></QueryClientProvider>);
    await user.type(await screen.findByLabelText('兑换码'), 'VIVIAI2026');
    await user.click(screen.getByRole('button', { name: '兑换积分' }));
    await screen.findByText('兑换码无效');
    await user.click(screen.getByRole('button', { name: '兑换积分' }));
    await waitFor(() => expect(redeemCode).toHaveBeenCalledTimes(2));
    expect(redeemCode.mock.calls[0][1]).not.toBe(redeemCode.mock.calls[1][1]);
  });

  it('reuses the original key and balance baseline for an uncertain redemption retry', async () => {
    const redeemCode = vi.spyOn(api, 'redeemCode').mockRejectedValueOnce(new TypeError('network unavailable')).mockResolvedValueOnce({ id: 'user-demo', username: 'Mia Chen', email: 'demo@viviai.local', planId: 'plan-pro-month', planName: '专业版月卡', credits: 1220, frozenCredits: 0, concurrency: 8, inviteCode: 'VIVI-MIA88' });
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('attempt-key-network');
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><MemoryRouter><AccountPage /></MemoryRouter></QueryClientProvider>);
    await user.type(await screen.findByLabelText('兑换码'), 'VIVIAI2026');
    await user.click(screen.getByRole('button', { name: '兑换积分' }));
    await screen.findByText('network unavailable');
    client.setQueryData(['me'], { id: 'user-demo', username: 'Mia Chen', email: 'demo@viviai.local', planId: 'plan-pro-month', planName: '专业版月卡', credits: 1220, frozenCredits: 0, concurrency: 8, inviteCode: 'VIVI-MIA88' });
    await user.click(screen.getByRole('button', { name: '兑换积分' }));
    expect(await screen.findByText('兑换成功，100 积分已到账。')).toBeVisible();
    expect(redeemCode.mock.calls.map((call) => call[1])).toEqual(['attempt-key-network', 'attempt-key-network']);
  });

  it('creates a new redemption key after the input is edited and after success cleanup', async () => {
    const redeemCode = vi.spyOn(api, 'redeemCode').mockRejectedValueOnce(new TypeError('network unavailable')).mockResolvedValue({ id: 'user-demo', username: 'Mia Chen', email: 'demo@viviai.local', planId: 'plan-pro-month', planName: '专业版月卡', credits: 1220, frozenCredits: 0, concurrency: 8, inviteCode: 'VIVI-MIA88' });
    vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce('attempt-key-edit').mockReturnValueOnce('attempt-key-success').mockReturnValueOnce('attempt-key-next');
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><MemoryRouter><AccountPage /></MemoryRouter></QueryClientProvider>);
    const input = await screen.findByLabelText('兑换码');
    await user.type(input, 'VIVIAI2026');
    await user.click(screen.getByRole('button', { name: '兑换积分' }));
    await screen.findByText('network unavailable');
    await user.type(input, 'X');
    await user.click(screen.getByRole('button', { name: '兑换积分' }));
    await screen.findByText('兑换成功，100 积分已到账。');
    await user.clear(input);
    await user.type(input, 'VIVIAI2026');
    await user.click(screen.getByRole('button', { name: '兑换积分' }));
    await waitFor(() => expect(redeemCode).toHaveBeenCalledTimes(3));
    expect(redeemCode.mock.calls[0][1]).not.toBe(redeemCode.mock.calls[1][1]);
    expect(redeemCode.mock.calls[1][1]).not.toBe(redeemCode.mock.calls[2][1]);
  });

  it('refreshes the baseline before submitting an edited code after an uncertain committed redemption', async () => {
    const initial = { id: 'user-demo', username: 'Mia Chen', email: 'demo@viviai.local', planId: 'plan-pro-month' as const, planName: '专业版月卡', credits: 1120, frozenCredits: 0, concurrency: 8, inviteCode: 'VIVI-MIA88' };
    const afterFirst = { ...initial, credits: 1220 };
    const afterSecond = { ...initial, credits: 1320 };
    const order: string[] = [];
    vi.spyOn(api, 'getMe').mockImplementationOnce(async () => initial).mockImplementationOnce(async () => { order.push('refresh'); return afterFirst; }).mockResolvedValue(afterSecond);
    const redeemCode = vi.spyOn(api, 'redeemCode').mockImplementationOnce(async () => { order.push('A'); throw new TypeError('response lost'); }).mockImplementationOnce(async () => { order.push('B'); return afterSecond; });
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><MemoryRouter><AccountPage /></MemoryRouter></QueryClientProvider>);
    const input = await screen.findByLabelText('兑换码');
    await user.type(input, 'A');
    await user.click(screen.getByRole('button', { name: '兑换积分' }));
    await screen.findByText('response lost');
    await user.clear(input);
    await user.type(input, 'B');
    await user.click(screen.getByRole('button', { name: '兑换积分' }));

    expect(await screen.findByText('兑换成功，100 积分已到账。')).toBeVisible();
    expect(order.slice(0, 3)).toEqual(['A', 'refresh', 'B']);
    expect(redeemCode.mock.calls[0][1]).not.toBe(redeemCode.mock.calls[1][1]);
  });

  it('does not submit an edited code when the authoritative baseline refresh fails', async () => {
    const initial = { id: 'user-demo', username: 'Mia Chen', email: 'demo@viviai.local', planId: 'plan-pro-month' as const, planName: '专业版月卡', credits: 1120, frozenCredits: 0, concurrency: 8, inviteCode: 'VIVI-MIA88' };
    vi.spyOn(api, 'getMe').mockImplementationOnce(async () => initial).mockRejectedValueOnce(new Error('refresh unavailable'));
    const redeemCode = vi.spyOn(api, 'redeemCode').mockRejectedValueOnce(new TypeError('response lost')).mockResolvedValue({ ...initial, credits: 1320 });
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><MemoryRouter><AccountPage /></MemoryRouter></QueryClientProvider>);
    const input = await screen.findByLabelText('兑换码');
    await user.type(input, 'A');
    await user.click(screen.getByRole('button', { name: '兑换积分' }));
    await screen.findByText('response lost');
    await user.clear(input);
    await user.type(input, 'B');
    await user.click(screen.getByRole('button', { name: '兑换积分' }));

    expect(await screen.findByText('无法刷新积分余额，请重试。')).toBeVisible();
    expect(redeemCode).toHaveBeenCalledTimes(1);
  });

  it('refetches the unread count after a successful redemption', async () => {
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><MemoryRouter><AccountPage /><NotificationCount /></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByText('未读 1')).toBeVisible();
    await user.type(screen.getByLabelText('兑换码'), 'VIVIAI2026');
    await user.click(screen.getByRole('button', { name: '兑换积分' }));

    expect(await screen.findByText('未读 2')).toBeVisible();
  });
});
