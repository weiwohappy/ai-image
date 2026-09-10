export const MANAGEMENT_ROLES = ['super_admin', 'system_admin', 'owner'];
const team = [
  'admins.create',
  'admins.update',
  'admins.roles.assign',
  'admins.status.update',
  'admins.password.reset',
  'roles.read',
];
export const ROLE_PERMISSIONS: Record<string, readonly string[]> = {
  super_admin: [
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
    'dashboard.business.read',
    'dashboard.finance.read',
    'dashboard.models.read',
    'dashboard.system.read',
    'dashboard.content.read',
    'alerts.service.read',
    'alerts.model.read',
    ...team,
    'roles.create',
    'roles.update',
    'roles.delete',
  ],
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
    'dashboard.business.read',
    'dashboard.finance.read',
    'dashboard.models.read',
    'dashboard.system.read',
    'alerts.service.read',
    'alerts.model.read',
    ...team,
  ],
  support: [
    'dashboard.read',
    'users.read',
    'orders.read',
    'credits.read',
    'jobs.read',
    'alerts.read',
    'dashboard.business.read',
    'alerts.service.read',
  ],
  finance: [
    'dashboard.read',
    'users.read',
    'orders.read',
    'credits.read',
    'jobs.read',
    'costs.read',
    'dashboard.business.read',
    'dashboard.finance.read',
  ],
  model_operator: [
    'dashboard.read',
    'models.read',
    'providers.read',
    'costs.read',
    'alerts.read',
    'dashboard.models.read',
    'alerts.model.read',
  ],
  content_operator: ['dashboard.read', 'dashboard.content.read'],
  system_admin: ['dashboard.read', 'audit.read', 'admins.read', 'dashboard.system.read', ...team],
};
export const ROLE_NAMES: Record<string, string> = {
  super_admin: '超级管理员',
  owner: '业务负责人',
  system_admin: '系统管理员',
  support: '客服',
  finance: '财务',
  model_operator: '模型运营',
  content_operator: '内容运营',
};
const labels: Record<string, string> = {
  'dashboard.read': '查看首页',
  'users.read': '查看用户',
  'orders.read': '查看订单',
  'credits.read': '查看积分',
  'jobs.read': '查看任务',
  'models.read': '查看模型',
  'providers.read': '查看提供方',
  'costs.read': '查看成本',
  'alerts.read': '查看告警',
  'audit.read': '查看审计',
  'admins.read': '查看团队',
  'roles.read': '查看角色',
  'dashboard.business.read': '首页业务统计',
  'dashboard.finance.read': '首页财务统计',
  'dashboard.models.read': '首页模型统计',
  'dashboard.system.read': '首页系统统计',
  'dashboard.content.read': '首页内容说明',
  'alerts.service.read': '服务告警',
  'alerts.model.read': '模型告警',
  'admins.create': '创建邀请',
  'admins.update': '编辑成员资料',
  'admins.roles.assign': '分配成员角色',
  'admins.status.update': '启用禁用成员',
  'admins.password.reset': '重置成员密码',
  'roles.create': '创建角色',
  'roles.update': '编辑角色',
  'roles.delete': '删除角色',
};
const dependencies: Record<string, string[]> = {
  'dashboard.business.read': ['dashboard.read', 'users.read', 'orders.read', 'jobs.read'],
  'dashboard.finance.read': ['dashboard.read', 'orders.read', 'credits.read'],
  'dashboard.models.read': ['dashboard.read', 'models.read'],
  'dashboard.system.read': ['dashboard.read', 'admins.read'],
  'dashboard.content.read': ['dashboard.read'],
  'alerts.service.read': ['alerts.read'],
  'alerts.model.read': ['alerts.read'],
};
export const PERMISSION_CATALOG = Object.entries(labels).map(([key, name]) => ({
  key,
  name,
  module: key.split('.')[0]!,
  dependencies:
    dependencies[key] ??
    (key.startsWith('admins.') && key !== 'admins.read'
      ? ['admins.read']
      : key.startsWith('roles.') && key !== 'roles.read'
        ? ['admins.read', 'roles.read']
        : []),
  customRoleAllowed:
    (!key.startsWith('admins.') || key === 'admins.read') &&
    (!key.startsWith('roles.') || key === 'roles.read'),
}));
export function validPermissionSet(values: string[], custom = false): boolean {
  return (
    values.length > 0 &&
    (!custom || values.includes('dashboard.read')) &&
    new Set(values).size === values.length &&
    values.every((key) => {
      const entry = PERMISSION_CATALOG.find((p) => p.key === key);
      return (
        !!entry &&
        (!custom || entry.customRoleAllowed) &&
        entry.dependencies.every((dep) => values.includes(dep))
      );
    })
  );
}
