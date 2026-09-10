import { AppError } from '../../shared/http/errors.js';
export { ROLE_PERMISSIONS } from './permission-catalog.js';
export function requirePermission(actor: { permissions: string[] }, permission: string) {
  if (!actor.permissions.includes(permission))
    throw new AppError(403, 'ADMIN_FORBIDDEN', '没有此操作权限');
}
