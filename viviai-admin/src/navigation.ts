import type { AdminActor } from './contracts';
import {
  Bell,
  BookImage,
  Boxes,
  CreditCard,
  Images,
  KeyRound,
  Layers,
  LayoutDashboard,
  ListChecks,
  Megaphone,
  Network,
  ScrollText,
  Shield,
  Sparkles,
  UserRoundPlus,
  Users,
  WandSparkles,
  Workflow,
} from 'lucide-react';
export const navigation = [
  {
    path: '/dashboard',
    label: '工作概览',
    permission: 'dashboard.read',
    group: '工作台',
    icon: LayoutDashboard,
  },
  { path: '/users', label: '用户与积分', permission: 'users.read', group: '业务查询', icon: Users },
  {
    path: '/orders',
    label: '支付订单',
    permission: 'orders.read',
    group: '业务查询',
    icon: CreditCard,
  },
  {
    path: '/jobs',
    label: '生成任务',
    permission: 'jobs.read',
    group: '业务查询',
    icon: ListChecks,
  },
  {
    path: '/models',
    label: '模型与规格',
    permission: 'models.read',
    group: '模型运行',
    icon: Layers,
  },
  {
    path: '/model-pricing',
    label: '积分定价',
    permission: 'models.read',
    group: '模型运行',
    icon: CreditCard,
  },
  {
    path: '/provider-accounts',
    label: 'API 提供方',
    permission: 'providers.read',
    group: '模型运行',
    icon: Network,
  },
  { path: '/alerts', label: '运行告警', permission: 'alerts.read', group: '模型运行', icon: Bell },
  {
    path: '/workflows',
    label: '工作流',
    permission: 'workflows.read',
    group: '任务运营',
    icon: Workflow,
  },
  {
    path: '/batches',
    label: '批量任务',
    permission: 'batches.read',
    group: '任务运营',
    icon: Boxes,
  },
  {
    path: '/content/inspirations',
    label: '灵感库',
    permission: 'content.inspirations.read',
    group: '内容运营',
    icon: Sparkles,
  },
  {
    path: '/content/remix-templates',
    label: '爆款模板',
    permission: 'content.templates.read',
    group: '内容运营',
    icon: BookImage,
  },
  {
    path: '/content/tools',
    label: 'AI 工具',
    permission: 'content.tools.read',
    group: '内容运营',
    icon: WandSparkles,
  },
  {
    path: '/content/media',
    label: '内容媒体库',
    permission: 'content.media.read',
    group: '内容运营',
    icon: Images,
  },
  {
    path: '/marketing/campaigns',
    label: '兑换活动',
    permission: 'redemptions.read',
    group: '营销运营',
    icon: Megaphone,
  },
  {
    path: '/marketing/codes',
    label: '兑换码',
    permission: 'redemptions.read',
    group: '营销运营',
    icon: KeyRound,
  },
  {
    path: '/marketing/referrals',
    label: '邀请返利',
    permission: 'referrals.read',
    group: '营销运营',
    icon: UserRoundPlus,
  },
  {
    path: '/audit-events',
    label: '操作审计',
    permission: 'audit.read',
    group: '团队安全',
    icon: ScrollText,
  },
  {
    path: '/administrators',
    label: '团队成员',
    permission: 'admins.read',
    group: '团队安全',
    icon: Users,
  },
  {
    path: '/roles',
    label: '角色与权限',
    permission: 'roles.read',
    group: '团队安全',
    icon: Shield,
  },
];
export function availableNavigation(actor: AdminActor) {
  return navigation.filter((item) => actor.permissions.includes(item.permission));
}
export function routePermission(path: string) {
  path = path.split('?')[0];
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
