import type { ImageRole } from './contracts.js';
import type { PriceSnapshot } from './pricing.js';
export interface ChannelProfile {
  id: string;
  enabled: boolean;
  simulated: boolean;
  baseUrl?: string;
  responseTimeoutMs?: number;
  pricing?: PriceSnapshot;
  productVersion: string;
  upstreamModelId: string;
  outputSpecId: string;
  width: number;
  height: number;
  region: string;
  roles: ImageRole[];
  credentialVersion: string;
  capabilityVersion: string;
  quotaScope: string;
  budgetScope: string;
  concurrency: number;
  maxUnknown: number;
  dailyBudgetMicros: bigint;
  estimatedCostMicros: bigint;
}
export const SIMULATED_PROFILES: readonly ChannelProfile[] = ['async', 'sync'].map(
  (mode, index) => ({
    id: `simulation-${mode}`,
    enabled: true,
    simulated: true as const,
    productVersion: 'simulation-image-v1',
    upstreamModelId: 'deterministic-png-v1',
    outputSpecId: 'png-1024-square-v1',
    width: 1024,
    height: 1024,
    region: 'local',
    roles: ['reference', 'subject'] as ImageRole[],
    credentialVersion: 'no-credentials-v1',
    capabilityVersion: 'simulation-v1',
    quotaScope: 'simulation-project',
    budgetScope: 'simulation-project',
    concurrency: 4,
    maxUnknown: 1,
    dailyBudgetMicros: 1_000_000n,
    estimatedCostMicros: BigInt(1000 + index * 200),
  }),
);
