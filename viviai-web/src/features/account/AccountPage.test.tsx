import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
});
