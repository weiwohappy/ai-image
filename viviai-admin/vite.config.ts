import { sites } from '@openai/sites-vite-plugin';
import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import { defineConfig } from 'vite';

export default defineConfig(async () => {
  process.env.WRANGLER_WRITE_LOGS ??= 'false';
  process.env.WRANGLER_LOG_PATH ??= '.wrangler/logs';
  process.env.MINIFLARE_REGISTRY_PATH ??= '.wrangler/registry';
  const { cloudflare } = await import('@cloudflare/vite-plugin');
  return {
    css: { postcss: { plugins: [tailwindcss()] } },
    server: {
      port: 3010,
      strictPort: true,
      ...(process.env.CODEX_SANDBOX === 'seatbelt'
        ? { watch: { useFsEvents: false, usePolling: true } }
        : {}),
      proxy: {
        '/api/admin': {
          target: process.env.ADMIN_BACKEND_URL ?? 'http://127.0.0.1:3001',
          changeOrigin: false,
        },
      },
    },
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
        config: {
          main: 'vinext/server/fetch-handler',
          compatibility_flags: ['nodejs_compat'],
          d1_databases: [],
          r2_buckets: [],
        },
      }),
    ],
  };
});
