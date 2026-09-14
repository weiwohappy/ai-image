import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { resetDb } from '@/src/mocks/db';
import { server } from '@/src/mocks/server';
import { InvitePage } from './InvitePage';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => resetDb());
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});
afterAll(() => server.close());

describe('invite page', () => {
  it('uses the current origin for the authenticated user invitation link', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><MemoryRouter><InvitePage /></MemoryRouter></QueryClientProvider>);

    expect(await screen.findByText(`${window.location.origin}/#/register?invite=VIVI-MIA88`)).toBeVisible();
  });

  it('does not claim a copied link when clipboard access is unavailable', async () => {
    const user = userEvent.setup();
    const originalClipboard = Object.getOwnPropertyDescriptor(window.navigator, 'clipboard');
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: undefined });
    expect(window.navigator.clipboard).toBeUndefined();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><MemoryRouter><InvitePage /></MemoryRouter></QueryClientProvider>);

    await user.click(await screen.findByRole('button', { name: '复制邀请链接' }));
    expect(await screen.findByText('无法访问剪贴板，请手动复制链接。')).toBeVisible();
    expect(screen.queryByRole('button', { name: '已复制' })).toBeNull();
    if (originalClipboard) Object.defineProperty(window.navigator, 'clipboard', originalClipboard);
  });
});
