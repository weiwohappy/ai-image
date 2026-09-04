'use client';

import { AppProviders } from './AppProviders';
import { AppRoutes } from './routes';

export function App() {
  return (
    <AppProviders>
      <AppRoutes />
    </AppProviders>
  );
}
