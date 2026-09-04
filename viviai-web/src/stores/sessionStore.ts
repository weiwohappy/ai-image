'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { ImageRatio, OutputCount, Quality, RemixStrength, Resolution } from '@/src/types/domain';

export interface GenerationDraft {
  prompt: string;
  modelId: string;
  resolution: Resolution;
  quality?: Quality;
  ratio: ImageRatio;
  count: OutputCount;
  referenceAssetId?: string;
  referencePreviewUrl?: string;
  referenceName?: string;
}

export interface RemixDraft {
  adaptation: string;
  strength: RemixStrength;
  subjectAssetId?: string;
  resolution: Resolution;
  ratio: ImageRatio;
  count: OutputCount;
  initialized?: boolean;
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
  remixDrafts: Record<string, RemixDraft>;
  pendingRemixTemplateId?: string;
  updateGenerationDraft: (patch: Partial<GenerationDraft>) => void;
  updateRemixDraft: (templateId: string, patch: Partial<RemixDraft>) => void;
  setPendingGeneration: (pending: boolean) => void;
  setPendingRemixTemplateId: (templateId?: string) => void;
  resetGenerationDraft: () => void;
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      generationDraft: initialDraft,
      pendingGeneration: false,
      remixDrafts: {},
      updateGenerationDraft: (patch) => set((state) => ({ generationDraft: { ...state.generationDraft, ...patch } })),
      updateRemixDraft: (templateId, patch) => set((state) => {
        const current = state.remixDrafts[templateId] ?? { adaptation: '', strength: 'balanced' as const, resolution: '1K' as const, ratio: '1:1' as const, count: 1 as const };
        return { remixDrafts: { ...state.remixDrafts, [templateId]: { ...current, ...patch } } };
      }),
      setPendingGeneration: (pendingGeneration) => set({ pendingGeneration }),
      setPendingRemixTemplateId: (pendingRemixTemplateId) => set({ pendingRemixTemplateId }),
      resetGenerationDraft: () => set({ generationDraft: initialDraft, pendingGeneration: false }),
    }),
    { name: 'viviai-session-v1' },
  ),
);
