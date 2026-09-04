'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { ImageRatio, OutputCount, Quality, Resolution } from '@/src/types/domain';

export interface GenerationDraft {
  prompt: string;
  modelId: string;
  resolution: Resolution;
  quality?: Quality;
  ratio: ImageRatio;
  count: OutputCount;
  referenceAssetId?: string;
}

const initialDraft: GenerationDraft = {
  prompt: '',
  modelId: 'nano-banana-2',
  resolution: '1K',
  ratio: '1:1',
  count: 1,
};

interface SessionState {
  generationDraft: GenerationDraft;
  pendingGeneration: boolean;
  updateGenerationDraft: (patch: Partial<GenerationDraft>) => void;
  setPendingGeneration: (pending: boolean) => void;
  resetGenerationDraft: () => void;
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      generationDraft: initialDraft,
      pendingGeneration: false,
      updateGenerationDraft: (patch) => set((state) => ({ generationDraft: { ...state.generationDraft, ...patch } })),
      setPendingGeneration: (pendingGeneration) => set({ pendingGeneration }),
      resetGenerationDraft: () => set({ generationDraft: initialDraft, pendingGeneration: false }),
    }),
    { name: 'viviai-session-v1' },
  ),
);
