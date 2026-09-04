import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { resetDb } from '@/src/mocks/db';
import { server } from '@/src/mocks/server';
import { WorkflowEditorPage } from './WorkflowEditorPage';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => resetDb());
afterEach(() => cleanup());
afterAll(() => server.close());

describe('workflow editor', () => {
  it('requires a save before selected rows can run', async () => {
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/workflows/new']}><Routes><Route path="/workflows/:workflowId" element={<WorkflowEditorPage />} /></Routes></MemoryRouter></QueryClientProvider>);

    const run = await screen.findByRole('button', { name: '运行所选 2 个任务' });
    expect(run).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText(/已保存 · 版本 1/)).toBeVisible();
    expect(screen.getByRole('button', { name: '运行所选 2 个任务' })).toBeEnabled();
  });
});
