import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../../main.js';
import { BillingService } from './billing.service.js';

// Dedicated maintenance entrypoint: no listening HTTP socket and no image-provider worker.
const app = await createApp({}, { shutdownHooks: false });
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => controller.abort());
try {
  do {
    await app.get(BillingService).reconcile();
    if (!process.argv.includes('--watch')) break;
    await delay(30_000, undefined, { signal: controller.signal }).catch(() => undefined);
  } while (!controller.signal.aborted);
} finally {
  await app.close();
}
