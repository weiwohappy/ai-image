import type { AppConfig } from '../../config.js';
import { officialSnapshot } from './official-config.js';
import { thirdPartyImageSnapshot } from './third-party-config.js';

/**
 * The one judgment of whether an enabled channel can serve this model, specification and ratio.
 *
 * Availability belongs to the model and its specification, not to a channel: the operator console
 * and the public catalog both read it from here, so neither can claim a model is sellable while the
 * other calls it unavailable. The provider protocols stay separate — this only decides precedence
 * between them, which is why callers must not re-derive it from a single channel's snapshot.
 */
export function resolveImageExecution(
  config: Pick<AppConfig, 'officialImages' | 'thirdPartyImages'>,
  modelId: string,
  resolution: string,
  ratio: string,
) {
  return (
    officialSnapshot(config.officialImages, modelId, resolution, ratio) ??
    thirdPartyImageSnapshot(config.thirdPartyImages, modelId, resolution, ratio)
  );
}
