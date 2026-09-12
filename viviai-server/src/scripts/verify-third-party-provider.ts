import { loadConfig } from '../config.js';
import { OpenAICompatibleChatClient } from '../modules/providers/third-party/openai-compatible.js';
import { redactThirdPartyConfig } from '../modules/providers/third-party-config.js';

const config = loadConfig().thirdPartyChat;
if (!config) {
  console.error('Sub2API is disabled; set SUB2API_ENABLED=true with server-only credentials.');
  process.exitCode = 2;
} else {
  const result = await new OpenAICompatibleChatClient(config).verify();
  console.info(JSON.stringify({ provider: redactThirdPartyConfig(config), result }));
  process.exitCode = result.ok ? 0 : 1;
}
