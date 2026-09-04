import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { resetDb } from '@/src/mocks/db';
import { server } from '@/src/mocks/server';
import { AssetsPage } from './AssetsPage';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => resetDb());
afterEach(() => cleanup());
afterAll(() => server.close());

describe('asset library', () => {
  it('filters assets by name and can favorite a result', async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><MemoryRouter><AssetsPage /></MemoryRouter></QueryClientProvider>);

    await screen.findByText('琥珀香氛主视觉');
    await user.type(screen.getByLabelText('搜索资产'), '森林');
    expect(await screen.findByText('森林精华瓶')).toBeVisible();
    expect(screen.queryByText('琥珀香氛主视觉')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '取消收藏森林精华瓶' }));
    expect(await screen.findByRole('button', { name: '收藏森林精华瓶' })).toBeVisible();
  });
});
