'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api, isRealApi } from '@/src/services/api';
import { retryGeneration } from '@/src/services/generationFlow';
import { queryKeys } from '@/src/services/queryKeys';
import type { GenerationTask } from '@/src/types/domain';

export async function refreshActiveTaskDetails(
  listed: GenerationTask[],
  getDetail: (id: string) => Promise<GenerationTask> = api.getGenerationTask,
): Promise<GenerationTask[]> {
  const active = listed.filter((task) => task.status === 'queued' || task.status === 'processing');
  if (!active.length) return listed;
  const detailed = await Promise.all(active.map((task) => getDetail(task.id)));
  const byId = new Map(detailed.map((task) => [task.id, task]));
  return listed.map((task) => byId.get(task.id) ?? task);
}

export function useGenerationTasks() {
  const queryClient = useQueryClient();
  const { data: me } = useQuery({ queryKey: queryKeys.me, queryFn: api.getMe });
  const tasks = useQuery({ queryKey: queryKeys.tasks, queryFn: async () => {
    const listed = await api.listGenerationTasks();
    if (!isRealApi()) return listed;
    return refreshActiveTaskDetails(listed);
  }, enabled: Boolean(me), refetchInterval: (query) => query.state.data?.some((task) => task.status === 'queued' || task.status === 'processing') ? (isRealApi() ? 900 : 500) : false });
  const assets = useQuery({ queryKey: queryKeys.assets, queryFn: () => api.listAssets(), enabled: Boolean(me) });
  const resultAssetKey = tasks.data?.flatMap((task) => task.resultAssetIds).join(',') ?? '';
  useEffect(() => {
    if (resultAssetKey) void queryClient.invalidateQueries({ queryKey: queryKeys.assets });
  }, [queryClient, resultAssetKey]);
  const refresh = async () => { await Promise.all([queryClient.invalidateQueries({ queryKey: queryKeys.tasks }), queryClient.invalidateQueries({ queryKey: queryKeys.assets }), queryClient.invalidateQueries({ queryKey: queryKeys.me })]); };
  const cancel = useMutation({ mutationFn: api.cancelGenerationTask, onSuccess: refresh });
  const retry = useMutation({ mutationFn: retryGeneration, onSuccess: (task) => queryClient.setQueryData<GenerationTask[]>(queryKeys.tasks, (current = []) => [task, ...current]) });
  return {
    tasks: me ? tasks : { ...tasks, data: [] },
    assets: me ? assets : { ...assets, data: [] },
    cancel,
    retry,
  };
}
