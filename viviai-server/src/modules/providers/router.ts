import type { NormalizedImageRequest, ProviderContext } from './contracts.js';
import type { Channel, ProviderRegistry } from './registry.js';
export function providerContext(channel: Channel, requestKey: string): ProviderContext {
  return {
    channelId: channel.profile.id,
    credentialVersionRef: channel.profile.credentialVersion,
    capabilityVersionId: channel.profile.capabilityVersion,
    baseUrl: channel.profile.baseUrl ?? 'simulation://local',
    region: channel.profile.region,
    requestKey,
    connectTimeoutMs: 1000,
    responseTimeoutMs: channel.profile.responseTimeoutMs ?? 30_000,
    signal: AbortSignal.timeout(channel.profile.responseTimeoutMs ?? 30_000),
  };
}
export function candidates(
  registry: ProviderRegistry,
  request: NormalizedImageRequest,
  excluded: string[],
): Channel[] {
  return registry.channels
    .filter((channel) => {
      const p = channel.profile;
      const context = providerContext(channel, request.attemptId);
      const caps = channel.adapter.capabilities(context);
      if (
        !p.enabled ||
        excluded.includes(p.id) ||
        p.productVersion !== request.productModelVersionId ||
        p.upstreamModelId !== request.upstreamModelId ||
        p.outputSpecId !== request.outputSpecId ||
        p.region !== (request.providerRegion ?? 'local') ||
        (request.channelId !== undefined && p.id !== request.channelId) ||
        p.width !== request.output.width ||
        p.height !== request.output.height ||
        !caps.executionModes.includes(request.executionMode) ||
        request.images.length > caps.maxReferenceImages ||
        request.images.some(
          (image) => !p.roles.includes(image.role) || !caps.supportedRoles.includes(image.role),
        )
      )
        return false;
      try {
        channel.adapter.validate(request, context);
        return true;
      } catch {
        return false;
      }
    })
    .sort((a, b) =>
      a.profile.estimatedCostMicros < b.profile.estimatedCostMicros
        ? -1
        : a.profile.estimatedCostMicros > b.profile.estimatedCostMicros
          ? 1
          : a.profile.id.localeCompare(b.profile.id),
    );
}
