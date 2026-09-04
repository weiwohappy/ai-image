'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/src/services/api';
import { queryKeys } from '@/src/services/queryKeys';
import type { GenerationTask } from '@/src/types/domain';

export function useGenerationTasks() {
  const queryClient = useQueryClient();
  const tasks = useQuery({ queryKey: queryKeys.tasks, queryFn: api.listGenerationTasks, refetchInterval: (query) => query.state.data?.some((task) => task.status === 'queued' || task.status === 'processing') ? 500 : false });
  const assets = useQuery({ queryKey: queryKeys.assets, queryFn: () => api.listAssets() });
  const refresh = async () => { await Promise.all([queryClient.invalidateQueries({ queryKey: queryKeys.tasks }), queryClient.invalidateQueries({ queryKey: queryKeys.assets }), queryClient.invalidateQueries({ queryKey: queryKeys.me })]); };
  const cancel = useMutation({ mutationFn: api.cancelGenerationTask, onSuccess: refresh });
  const retry = useMutation({ mutationFn: api.retryGenerationTask, onSuccess: (task) => queryClient.setQueryData<GenerationTask[]>(queryKeys.tasks, (current = []) => [task, ...current]) });
  return { tasks, assets, cancel, retry };
}
