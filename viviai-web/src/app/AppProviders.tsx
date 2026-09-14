'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HashRouter } from 'react-router-dom';
import { useEffect, useState, type ReactNode } from 'react';
import { registerViviaiTools } from '@/src/webmcp/registerTools';

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

  useEffect(() => {
    const refresh = () => queryClient.invalidateQueries();
    const expireSession = () => {
      queryClient.clear();
      if (!window.location.hash.startsWith('#/login')) window.location.hash = '#/login';
    };
    window.addEventListener('viviai:data-changed', refresh);
    window.addEventListener('viviai:data-reset', refresh);
    window.addEventListener('viviai:auth-expired', expireSession);
    const disposeTools = registerViviaiTools();
    return () => {
      disposeTools();
      window.removeEventListener('viviai:data-changed', refresh);
      window.removeEventListener('viviai:data-reset', refresh);
      window.removeEventListener('viviai:auth-expired', expireSession);
    };
  }, [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <HashRouter>{children}</HashRouter>
    </QueryClientProvider>
  );
}
