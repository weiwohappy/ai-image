import { pathToFileURL } from 'node:url';
import { createApp } from './main.js';
import { loadConfig, validateConfig, type AppConfig } from './config.js';
import { DatabaseService } from './shared/database/database.service.js';
import { ASSET_STORE } from './modules/assets/assets.service.js';
import type { ObjectStore } from './modules/assets/object-store.js';
import { WalletService } from './modules/wallet/wallet.service.js';
import { buildProviderRegistry } from './modules/providers/official-runtime.js';
import { DispatchService } from './modules/generation/dispatch.service.js';
import { QueueRuntime } from './shared/queue/queue-runtime.js';

export async function startWorker(overrides: Partial<AppConfig> = {}) {
  const config = validateConfig({ ...loadConfig(), ...overrides });
  if (!config.simulationProviderEnabled && !config.officialImages?.models.length)
    throw new Error('No explicitly enabled image provider');
  // Worker owns shutdown ordering: stop scheduling, drain work, then close DB.
  const app = await createApp(config, { shutdownHooks: false });
  const db = app.get(DatabaseService);
  const store = app.get<ObjectStore>(ASSET_STORE);
  const runtime = new QueueRuntime(
    db,
    new DispatchService(db, new WalletService(db), store, buildProviderRegistry(config, store)),
    config.redisUrl,
    config.queueNamespace,
  );
  try {
    await runtime.start();
  } catch (error) {
    await runtime.close();
    await app.close();
    throw error;
  }
  return {
    runtime,
    async close() {
      await runtime.close();
      await app.close();
    },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startWorker().then(
    (worker) => {
      console.info(
        'VIVIAI image worker started; provider availability follows server configuration',
      );
      let stopping = false;
      for (const signal of ['SIGINT', 'SIGTERM'] as const)
        process.once(signal, () => {
          if (stopping) return;
          stopping = true;
          void worker.close().then(
            () => {
              process.exitCode = 0;
            },
            () => {
              process.exitCode = 1;
            },
          );
        });
    },
    () => {
      console.error('Worker startup failed; verify local database, Redis and configuration');
      process.exitCode = 1;
    },
  );
}
