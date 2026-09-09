import { AppError } from '../../shared/http/errors.js';
export const ROLE_PERMISSIONS: Record<string, readonly string[]> = {
  owner: [
    'dashboard.read',
    'users.read',
    'orders.read',
    'credits.read',
    'jobs.read',
    'models.read',
    'providers.read',
    'costs.read',
    'alerts.read',
    'audit.read',
    'admins.read',
  ],
  support: [
    'dashboard.read',
    'users.read',
    'orders.read',
    'credits.read',
    'jobs.read',
    'alerts.read',
  ],
  finance: [
    'dashboard.read',
    'users.read',
    'orders.read',
    'credits.read',
    'jobs.read',
    'costs.read',
  ],
  model_operator: ['dashboard.read', 'models.read', 'providers.read', 'costs.read', 'alerts.read'],
  content_operator: ['dashboard.read'],
  system_admin: ['dashboard.read', 'audit.read', 'admins.read'],
};
export function permissions(roles: string[], extras: string[]) {
  if (
    !roles.length ||
    roles.some((r) => !Object.hasOwn(ROLE_PERMISSIONS, r)) ||
    extras.some((p) => p !== 'sensitive.read')
  )
    return [];
  return [...new Set([...roles.flatMap((r) => ROLE_PERMISSIONS[r]!), ...extras])].sort();
}
export function requirePermission(actor: { permissions: string[] }, permission: string) {
  if (!actor.permissions.includes(permission))
    throw new AppError(403, 'ADMIN_FORBIDDEN', 'Access is not permitted');
}
