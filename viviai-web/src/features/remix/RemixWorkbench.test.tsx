import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { resetDb } from '@/src/mocks/db';
import { server } from '@/src/mocks/server';
import { RemixWorkbench } from './RemixWorkbench';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => resetDb());
afterEach(() => cleanup());
afterAll(() => server.close());

describe('viral remix workbench', () => {
  it('requires an adaptation and defaults to balanced strength', async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><MemoryRouter><RemixWorkbench templateId="template-1" /></MemoryRouter></QueryClientProvider>);

    expect(await screen.findByRole('radio', { name: '平衡复刻' })).toBeChecked();
    const submit = screen.getByRole('button', { name: '开始复刻' });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText('描述你要修改的内容'), '替换为新款咖啡礼盒');
    expect(submit).toBeEnabled();
  });
});
