import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { resetDb } from '@/src/mocks/db';
import { server } from '@/src/mocks/server';
import { NotificationSheet } from './NotificationSheet';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => resetDb());
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});
afterAll(() => server.close());

describe('notification sheet', () => {
  it('loads real-mode notifications and marks every unread item as read', async () => {
    vi.stubEnv('VITE_API_MODE', 'real');
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><MemoryRouter><NotificationSheet open onClose={() => undefined} /></MemoryRouter></QueryClientProvider>);

    expect(await screen.findByText('欢迎来到 VIVIAI')).toBeVisible();
    expect(screen.getByText('未读 1')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '全部标为已读' }));
    expect(await screen.findByText('全部通知已读')).toBeVisible();
    expect(screen.getByText('未读 0')).toBeVisible();
  });
});
