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
  updateGenerationDraft: (patch: Partial<GenerationDraft>) => void;
  resetGenerationDraft: () => void;
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      generationDraft: initialDraft,
      updateGenerationDraft: (patch) => set((state) => ({ generationDraft: { ...state.generationDraft, ...patch } })),
      resetGenerationDraft: () => set({ generationDraft: initialDraft }),
    }),
    { name: 'viviai-session-v1' },
  ),
);
