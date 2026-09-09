import type { AppConfig } from '../../config.js';
import type { ObjectStore } from '../assets/object-store.js';
import { OFFICIAL_MODELS, officialSpecs } from './official-models.js';
import { officialSnapshot, validateOfficialConfig } from './official-config.js';
import { GoogleImageProvider } from './official/google.js';
import { OpenAIImageProvider } from './official/openai.js';
import { ProviderRegistry, type Channel } from './registry.js';
import { SIMULATED_PROFILES } from './provider-config.js';
import { SimulatedProvider } from './simulated-provider.js';

export function buildProviderRegistry(
  config: AppConfig,
  store: ObjectStore,
  fetcher?: typeof fetch,
): ProviderRegistry {
  const channels: Channel[] =
    config.simulationProviderEnabled && config.nodeEnv !== 'production'
      ? SIMULATED_PROFILES.map((profile) => ({
          profile,
          adapter: new SimulatedProvider(store, profile.id.endsWith('async') ? 'async' : 'sync'),
        }))
      : [];
  const settings = config.officialImages;
  if (settings) {
    validateOfficialConfig(settings);
    for (const model of settings.models) {
      const definition = OFFICIAL_MODELS.find((d) => d.id === model.modelId)!;
      const account = settings.accounts[definition.provider]!;
      const adapter =
        definition.provider === 'google'
          ? new GoogleImageProvider(store, settings.credentials.google!, fetcher)
          : new OpenAIImageProvider(store, settings.credentials.openai!, fetcher);
      for (const spec of officialSpecs(model.modelId)) {
        const snapshot = officialSnapshot(settings, model.modelId, spec.resolution, spec.ratio);
        if (!snapshot) continue;
        channels.push({
          adapter,
          profile: {
            id: snapshot.channelId,
            enabled: true,
            simulated: false,
            productVersion: model.modelId,
            upstreamModelId: model.modelId,
            outputSpecId: spec.id,
            width: spec.width,
            height: spec.height,
            region: 'global',
            roles: definition.maxImages === 1 ? ['reference'] : ['reference', 'subject'],
            credentialVersion: account.credentialVersion,
            capabilityVersion: `${adapter.protocol}-${snapshot.revision}`,
            quotaScope: `official-${definition.provider}-${account.scope}`,
            budgetScope: `official-usd-${definition.provider}-${account.scope}`,
            concurrency: account.concurrency,
            maxUnknown: account.maxUnknown,
            dailyBudgetMicros: BigInt(account.dailyBudgetMicros),
            estimatedCostMicros: BigInt(model.reserveCostMicros),
            pricing: model.pricing,
            responseTimeoutMs: 180_000,
            baseUrl:
              definition.provider === 'google'
                ? 'https://generativelanguage.googleapis.com'
                : 'https://api.openai.com',
          },
        });
      }
    }
  }
  return new ProviderRegistry(store, channels);
}
