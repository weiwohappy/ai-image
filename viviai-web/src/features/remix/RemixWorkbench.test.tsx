import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { resetDb } from '@/src/mocks/db';
import { server } from '@/src/mocks/server';
import { useSessionStore } from '@/src/stores/sessionStore';
import { RemixWorkbench } from './RemixWorkbench';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetDb(); useSessionStore.setState({ remixDrafts: {}, pendingRemixTemplateId: undefined }); });
afterEach(() => cleanup());
afterAll(() => server.close());

describe('viral remix workbench', () => {
  it('requires a user reference even when the adaptation is filled in', async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><MemoryRouter><RemixWorkbench /></MemoryRouter></QueryClientProvider>);

    expect(await screen.findByRole('radio', { name: '平衡复刻' })).toBeChecked();
    expect(screen.getByLabelText('上传爆款参考图')).toHaveAttribute('type', 'file');
    await user.type(screen.getByLabelText(/描述希望保留和修改的内容/), '保留光影，换成咖啡礼盒');
    expect(screen.getByRole('button', { name: '开始复刻' })).toBeDisabled();
  });

  it('still allows a legacy example reference with an adaptation', async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><MemoryRouter><RemixWorkbench templateId="template-1" /></MemoryRouter></QueryClientProvider>);

    expect(await screen.findByRole('radio', { name: '平衡复刻' })).toBeChecked();
    const submit = screen.getByRole('button', { name: '开始复刻' });
    expect(submit).toBeDisabled();
    await screen.findByAltText('爆款参考图预览');
    await user.type(screen.getByLabelText(/描述希望保留和修改的内容/), '替换为新款咖啡礼盒');
    expect(submit).toBeEnabled();
  });
});
