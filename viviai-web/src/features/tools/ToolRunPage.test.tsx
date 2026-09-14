import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';

import { resetDb, mutateDb } from '@/src/mocks/db';
import { server } from '@/src/mocks/server';
import type { ToolRunQuote } from '@/src/types/domain';
import { ToolRunPage } from './ToolRunPage';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => resetDb());
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

const envelope = (data: unknown) => HttpResponse.json({ data, message: 'ok', requestId: 'test' });
const quote = (overrides: Partial<ToolRunQuote> = {}): ToolRunQuote => ({
  quoteId: 'quote-1',
  toolId: 'product-polish',
  toolVersion: 1,
  modelId: 'nano-banana-2',
  resolution: '1K',
  ratio: '1:1',
  count: 1,
  unitCredits: 4,
  totalCredits: 4,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  ...overrides,
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/tools/product-polish']}>
        <Routes>
          <Route path="/tools/:toolId" element={<ToolRunPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function fillValidForm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: '选择琥珀香氛主视觉' }));
  await user.selectOptions(screen.getByLabelText('产品类型'), '护肤品');
}

describe('schema driven tool runner', () => {
  it('requires an asset and every required schema field', async () => {
    const user = userEvent.setup();
    mount();

    const submit = await screen.findByRole('button', { name: '开始生成' });
    expect(submit).toBeDisabled();
    await user.click(await screen.findByRole('button', { name: '选择琥珀香氛主视觉' }));
    await user.selectOptions(screen.getByLabelText('产品类型'), '护肤品');
    expect(submit).toBeEnabled();
  });

  it('shows the server-quoted total instead of a client estimate', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('*/api/tool-run-quotes', () => envelope(quote({ unitCredits: 999, totalCredits: 999 }))),
    );
    mount();
    await fillValidForm(user);

    await user.click(screen.getByRole('button', { name: '开始生成' }));

    expect(await screen.findByTestId('quote-total')).toHaveTextContent('999 积分');
    expect(screen.getByRole('button', { name: '确认生成' })).toBeEnabled();
  });

  it('disables confirmation once the quote has expired', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('*/api/tool-run-quotes', () =>
        envelope(quote({ expiresAt: new Date(Date.now() - 1_000).toISOString() })),
      ),
    );
    mount();
    await fillValidForm(user);

    await user.click(screen.getByRole('button', { name: '开始生成' }));

    expect(await screen.findByText('报价已过期')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认生成' })).toBeDisabled();
  });

  it('refreshes the quote after a form change is re-submitted', async () => {
    const user = userEvent.setup();
    let calls = 0;
    server.use(
      http.post('*/api/tool-run-quotes', () => {
        calls += 1;
        return envelope(quote({ quoteId: `quote-${calls}`, totalCredits: 4 + calls }));
      }),
    );
    mount();
    await fillValidForm(user);

    await user.click(screen.getByRole('button', { name: '开始生成' }));
    expect(await screen.findByTestId('quote-total')).toHaveTextContent('5 积分');
    await user.keyboard('{Escape}');

    await user.selectOptions(screen.getByLabelText('产品类型'), '服装');
    await user.click(screen.getByRole('button', { name: '开始生成' }));

    expect(await screen.findByTestId('quote-total')).toHaveTextContent('6 积分');
    expect(calls).toBe(2);
  });

  it('surfaces an insufficient-credit failure from the server', async () => {
    const user = userEvent.setup();
    mutateDb((draft) => {
      draft.user.credits = 0;
    });
    mount();
    await fillValidForm(user);

    await user.click(screen.getByRole('button', { name: '开始生成' }));
    await screen.findByRole('button', { name: '确认生成' });
    await user.click(screen.getByRole('button', { name: '确认生成' }));

    expect(await screen.findAllByText('积分不足，请升级套餐。')).not.toHaveLength(0);
  });

  it('inserts the created tool task into the task cache and closes the dialog', async () => {
    const user = userEvent.setup();
    mount();
    await fillValidForm(user);

    await user.click(screen.getByRole('button', { name: '开始生成' }));
    await screen.findByRole('button', { name: '确认生成' });
    await user.click(screen.getByRole('button', { name: '确认生成' }));

    expect(await screen.findByText('产品精修：护肤品')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
