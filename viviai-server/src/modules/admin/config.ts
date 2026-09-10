import { encryptionKey } from './crypto.js';
import { z } from 'zod';
export interface AdminConfig {
  enabled: boolean;
  origins: string[];
  encryptionKey?: string;
  localTestEmails?: string[];
}
const loopbackHosts = new Set(['127.0.0.1', '::1', 'localhost']);
const loopbackAddresses = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function validateLocalEmails(value: unknown): string[] {
  const result = z
    .array(
      z
        .string()
        .email()
        .max(254)
        .refine((email) => email === email.trim().toLowerCase()),
    )
    .max(2)
    .refine((emails) => new Set(emails).size === emails.length)
    .safeParse(value);
  if (!result.success) throw new Error('Invalid local administrator test allowlist');
  return result.data;
}
function localOrigin(origin: string) {
  try {
    const url = new URL(origin);
    return (
      url.origin === origin &&
      ['http:', 'https:'].includes(url.protocol) &&
      ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
    );
  } catch {
    return false;
  }
}
type LocalPasswordContext = { admin?: AdminConfig; nodeEnv: string; host: string };
export function localTestPasswordsEnabled(config: LocalPasswordContext) {
  return !!(
    config.admin?.enabled &&
    config.nodeEnv === 'development' &&
    loopbackHosts.has(config.host) &&
    config.admin.localTestEmails?.length &&
    config.admin.origins.length &&
    config.admin.origins.every(localOrigin)
  );
}
export function adminPasswordMinimum(
  config: LocalPasswordContext,
  email: string,
  ip: string,
): 6 | 12 {
  return localTestPasswordsEnabled(config) &&
    loopbackAddresses.has(ip) &&
    config.admin!.localTestEmails!.includes(email)
    ? 6
    : 12;
}
export function validateAdminConfig(
  config: AdminConfig | undefined,
  environment: string,
  host?: string,
) {
  const emails = validateLocalEmails(config?.localTestEmails ?? []);
  if (
    emails.length &&
    (environment !== 'development' ||
      !host ||
      !loopbackHosts.has(host) ||
      !config?.origins.length ||
      !config.origins.every(localOrigin))
  )
    throw new Error('Local administrator password exceptions require loopback-only development');
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
    ...(env.ADMIN_LOCAL_TEST_EMAILS?.trim()
      ? {
          localTestEmails: validateLocalEmails(
            env.ADMIN_LOCAL_TEST_EMAILS.split(',').map((value) => value.trim().toLowerCase()),
          ),
        }
      : {}),
  };
}
