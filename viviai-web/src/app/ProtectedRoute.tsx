'use client';

import { useQuery } from '@tanstack/react-query';
import { Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';

import { api } from '@/src/services/api';
import { queryKeys } from '@/src/services/queryKeys';

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const location = useLocation();
  const me = useQuery({ queryKey: queryKeys.me, queryFn: api.getMe });

  if (me.isPending) {
    return <div className="m-6 h-40 animate-pulse rounded-2xl border border-border bg-card" aria-label="正在加载账户" />;
  }
  if (!me.data) {
    return <Navigate to={`/login?redirect=${encodeURIComponent(`${location.pathname}${location.search}`)}`} replace />;
  }
  return children;
}
