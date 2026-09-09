import { encryptionKey } from './crypto.js';
export interface AdminConfig {
  enabled: boolean;
  origins: string[];
  encryptionKey?: string;
}
export function validateAdminConfig(config: AdminConfig | undefined, environment: string) {
  if (!config?.enabled) return;
  if (environment === 'production')
    throw new Error('Admin production activation is unavailable in increment A');
  if (
    !config.origins.length ||
    config.origins.some((origin) => {
      try {
        const url = new URL(origin);
        return (
          url.origin !== origin ||
          !['http:', 'https:'].includes(url.protocol) ||
          (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
        );
      } catch {
        return true;
      }
    })
  )
    throw new Error('Admin requires explicit HTTPS or localhost origins');
  encryptionKey(config.encryptionKey ?? '');
}
export function loadAdminConfig(env: Record<string, string | undefined>): AdminConfig {
  if (env.ADMIN_ENABLED && !['true', 'false'].includes(env.ADMIN_ENABLED))
    throw new Error('Invalid ADMIN_ENABLED');
  return {
    enabled: env.ADMIN_ENABLED === 'true',
    origins:
      env.ADMIN_ORIGINS?.split(',')
        .map((x) => x.trim())
        .filter(Boolean) ?? [],
    ...(env.ADMIN_MFA_ENCRYPTION_KEY ? { encryptionKey: env.ADMIN_MFA_ENCRYPTION_KEY } : {}),
  };
}
