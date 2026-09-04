import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { resetDb } from '@/src/mocks/db';
import { server } from '@/src/mocks/server';
import { ToolRunPage } from './ToolRunPage';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => resetDb());
afterEach(() => cleanup());
afterAll(() => server.close());

describe('schema driven tool runner', () => {
  it('requires an asset and every required schema field', async () => {
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/tools/product-polish']}><Routes><Route path="/tools/:toolId" element={<ToolRunPage />} /></Routes></MemoryRouter></QueryClientProvider>);

    const submit = await screen.findByRole('button', { name: '开始生成' });
    expect(submit).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '选择琥珀香氛主视觉' }));
    await user.selectOptions(screen.getByLabelText('产品类型'), '护肤品');
    expect(submit).toBeEnabled();
  });
});
