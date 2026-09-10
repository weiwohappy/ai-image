import type { AdminActor } from './contracts';
export const navigation = [
  { path: '/dashboard', label: '工作概览', permission: 'dashboard.read', group: '工作台' },
  { path: '/users', label: '用户与积分', permission: 'users.read', group: '业务查询' },
  { path: '/orders', label: '支付订单', permission: 'orders.read', group: '业务查询' },
  { path: '/jobs', label: '生成任务', permission: 'jobs.read', group: '业务查询' },
  { path: '/models', label: '模型与规格', permission: 'models.read', group: '模型运行' },
  {
    path: '/provider-accounts',
    label: 'API 提供方',
    permission: 'providers.read',
    group: '模型运行',
  },
  { path: '/alerts', label: '运行告警', permission: 'alerts.read', group: '模型运行' },
  { path: '/audit-events', label: '操作审计', permission: 'audit.read', group: '团队安全' },
  { path: '/administrators', label: '团队成员', permission: 'admins.read', group: '团队安全' },
  { path: '/roles', label: '角色与权限', permission: 'roles.read', group: '团队安全' },
];
export function availableNavigation(actor: AdminActor) {
  return navigation.filter((item) => actor.permissions.includes(item.permission));
}
export function routePermission(path: string) {
  if (path.startsWith('/attempts/')) return 'jobs.read';
  if (/^\/users\/[^/]+\/credit-(lots|events)$/.test(path)) return 'credits.read';
  return navigation.find((item) => path === item.path || path.startsWith(`${item.path}/`))
    ?.permission;
}
export const roleLabels: Record<string, string> = {
  super_admin: '超级管理员',
  owner: '业务负责人',
  support: '客服',
  finance: '财务',
  model_operator: '模型运营',
  content_operator: '内容运营',
  system_admin: '系统管理员',
};
