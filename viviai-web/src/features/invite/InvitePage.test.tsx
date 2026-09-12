import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
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
    vi.stubEnv('VITE_API_MODE', 'real');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><MemoryRouter><InvitePage /></MemoryRouter></QueryClientProvider>);

    expect(await screen.findByText(`${window.location.origin}/#/register?invite=VIVI-MIA88`)).toBeVisible();
  });
});
