import type { ObjectStore } from '../assets/object-store.js';
import type { ProviderAdapter } from './contracts.js';
import { SIMULATED_PROFILES, type ChannelProfile } from './provider-config.js';
import { SimulatedProvider } from './simulated-provider.js';
export interface Channel {
  profile: ChannelProfile;
  adapter: ProviderAdapter;
}
export class ProviderRegistry {
  readonly channels: readonly Channel[];
  constructor(store: ObjectStore, channels?: readonly Channel[]) {
    this.channels =
      channels ??
      SIMULATED_PROFILES.map((profile) => ({
        profile,
        adapter: new SimulatedProvider(store, profile.id.endsWith('async') ? 'async' : 'sync'),
      }));
    if (new Set(this.channels.map((c) => c.profile.id)).size !== this.channels.length)
      throw new Error('Duplicate channel identity');
    for (const { profile } of this.channels)
      if (
        !profile.simulated ||
        profile.estimatedCostMicros <= 0n ||
        profile.dailyBudgetMicros < 0n ||
        profile.concurrency < 1 ||
        profile.maxUnknown < 1
      )
        throw new Error('Invalid simulation profile');
  }
  get(id: string): Channel {
    const channel = this.channels.find((c) => c.profile.id === id);
    if (!channel) throw new Error('Missing persisted channel');
    return channel;
  }
}
