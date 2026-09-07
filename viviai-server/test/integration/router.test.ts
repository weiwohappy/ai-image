import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from '../../src/modules/providers/registry.js';
import {
  SIMULATED_PROFILES,
  type ChannelProfile,
} from '../../src/modules/providers/provider-config.js';
import { SimulatedProvider } from '../../src/modules/providers/simulated-provider.js';
import { candidates } from '../../src/modules/providers/router.js';
import type { NormalizedImageRequest } from '../../src/modules/providers/contracts.js';
import type { ObjectStore } from '../../src/modules/assets/object-store.js';
const unusedStore: ObjectStore = {
  put: async () => {
    throw new Error('No I/O in routing');
  },
  get: async () => {
    throw new Error('No I/O in routing');
  },
  delete: async () => {
    throw new Error('No I/O in routing');
  },
};
const request: NormalizedImageRequest = {
  jobId: 'job',
  itemId: 'item',
  attemptId: 'attempt',
  productModelVersionId: 'simulation-image-v1',
  upstreamModelId: 'deterministic-png-v1',
  outputSpecId: 'png-1024-square-v1',
  prompt: 'test',
  promptTemplateVersion: 'v1',
  images: [
    {
      assetId: 'reference',
      role: 'reference',
      order: 0,
      sha256: 'digest',
      mimeType: 'image/png',
      width: 16,
      height: 24,
      objectKey: 'private/ref',
    },
  ],
  output: {
    width: 1024,
    height: 1024,
    format: 'png',
    allowedNativeDimensions: [{ width: 1024, height: 1024 }],
  },
  count: 1,
  executionMode: 'interactive',
  businessDeadlineAt: new Date().toISOString(),
};
describe('hard capability filters precede cost ranking', () => {
  it.each<Partial<ChannelProfile>>([
    { enabled: false },
    { productVersion: 'different-model' },
    { upstreamModelId: 'different-engine' },
    { outputSpecId: 'upscaled-output' },
    { region: 'foreign' },
    { width: 512 },
    { roles: [] },
  ])('does not choose an incompatible cheaper profile %j', (override) => {
    const adapter = new SimulatedProvider(unusedStore, 'sync');
    const registry = new ProviderRegistry(unusedStore, [
      {
        adapter,
        profile: { ...SIMULATED_PROFILES[0]!, id: 'cheap', estimatedCostMicros: 1n, ...override },
      },
      { adapter, profile: { ...SIMULATED_PROFILES[1]!, id: 'valid' } },
    ]);
    expect(candidates(registry, request, []).map((c) => c.profile.id)).toEqual(['valid']);
  });
  it('cannot retry an excluded channel or exceed actual adapter input capacity', () => {
    const adapter = new SimulatedProvider(unusedStore, 'sync');
    const registry = new ProviderRegistry(unusedStore, [
      { adapter, profile: SIMULATED_PROFILES[0]! },
    ]);
    expect(candidates(registry, request, [SIMULATED_PROFILES[0]!.id])).toEqual([]);
    expect(
      candidates(
        registry,
        { ...request, images: [request.images[0]!, request.images[0]!, request.images[0]!] },
        [],
      ),
    ).toEqual([]);
  });
});
