'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HashRouter } from 'react-router-dom';
import { useEffect, useState, type ReactNode } from 'react';

export function AppProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false, staleTime: 10_000 },
          mutations: { retry: false },
        },
      }),
  );
  const [mockReady, setMockReady] = useState(process.env.NODE_ENV === 'test');

  useEffect(() => {
    if (process.env.NODE_ENV === 'test') return;
    let active = true;
    import('@/src/mocks/browser').then(({ worker }) =>
      worker.start({ onUnhandledRequest: 'bypass' }).then(() => {
        if (active) setMockReady(true);
      }),
    );
    return () => {
      active = false;
    };
  }, []);

  if (!mockReady) {
    return (
      <main className="grid min-h-screen place-items-center bg-background text-foreground">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <span className="size-2 animate-pulse rounded-full bg-primary" />
          正在准备创作工作台
        </div>
      </main>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <HashRouter>{children}</HashRouter>
    </QueryClientProvider>
  );
}
