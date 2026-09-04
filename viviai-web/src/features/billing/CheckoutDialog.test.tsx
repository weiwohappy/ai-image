import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { resetDb } from '@/src/mocks/db';
import { server } from '@/src/mocks/server';
import { PricingPage } from './PricingPage';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => resetDb());
afterEach(() => cleanup());
afterAll(() => server.close());

describe('mock checkout', () => {
  it('updates plan entitlements after a simulated payment', async () => {
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><MemoryRouter><PricingPage /></MemoryRouter></QueryClientProvider>);

    await user.click(await screen.findByRole('button', { name: '购买高级版月卡' }));
    await user.click(screen.getByRole('radio', { name: '支付宝' }));
    await user.click(screen.getByRole('button', { name: '模拟支付成功' }));
    expect(await screen.findByText('高级版月卡已到账')).toBeVisible();
    expect(screen.getByText('2,000 积分')).toBeVisible();
  });
});
