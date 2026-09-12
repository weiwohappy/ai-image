import { loadConfig } from '../config.js';
import { OpenAICompatibleImageClient } from '../modules/providers/third-party/openai-compatible.js';

const config = loadConfig().thirdPartyImages;
if (!config) {
  console.error(
    'Sub2API image channel is disabled; set SUB2API_ENABLED=true and SUB2API_IMAGE_MODELS_JSON.',
  );
  process.exitCode = 1;
} else {
  const result = await new OpenAICompatibleImageClient(
    config,
    config.models.map((model) => model.modelId),
  ).verify();
  console.log(
    JSON.stringify({
      provider: {
        id: config.id,
        kind: config.kind,
        baseUrl: config.baseUrl,
        models: config.models.map((model) => ({
          modelId: model.modelId,
          enabledResolutions: model.enabledResolutions,
        })),
        scope: config.scope,
        credentialVersion: config.credentialVersion,
        concurrency: config.concurrency,
        maxUnknown: config.maxUnknown,
        dailyBudgetMicros: config.dailyBudgetMicros,
        credentialConfigured: config.apiKey.length > 0,
      },
      result,
    }),
  );
  if (!result.ok) process.exitCode = 1;
}
