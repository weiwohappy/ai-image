import type { AdminActor, AdminTable } from '../contracts';
export const actor: AdminActor = {
  id: 'a',
  email: 'staff@example.test',
  displayName: '值班同事',
  roles: ['support'],
  permissions: [
    'dashboard.read',
    'users.read',
    'orders.read',
    'credits.read',
    'jobs.read',
    'alerts.read',
  ],
  sessionExpiresAt: '2099-01-01T00:00:00Z',
};
export const emptyTable: AdminTable = {
  title: '告警',
  columns: [{ key: 'id', label: 'ID' }],
  rows: [],
  nextCursor: null,
  asOf: '2026-09-09T00:00:00Z',
  notices: [],
};
export function json(data: unknown, status = 200) {
  return new Response(
    JSON.stringify({
      data,
      code: status === 200 ? 'OK' : 'ERROR',
      message: 'ok',
      requestId: 'test',
    }),
    { status },
  );
}
