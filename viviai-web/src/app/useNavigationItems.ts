import {
  Boxes,
  Compass,
  CreditCard,
  FolderOpen,
  Images,
  Sparkles,
  WandSparkles,
  Workflow,
} from 'lucide-react';

export const navigationItems = [
  { to: '/create', label: '图片生成', icon: Sparkles },
  { to: '/inspiration', label: '灵感', icon: Compass },
  { to: '/remix', label: '爆款复刻', icon: WandSparkles },
  { to: '/assets', label: '我的资产', icon: Images },
  { to: '/tools', label: '工具中心', icon: Boxes },
  { to: '/workflows', label: '工作流', icon: Workflow },
  { to: '/tasks', label: '任务中心', icon: FolderOpen },
  { to: '/pricing', label: '升级套餐', icon: CreditCard },
] as const;
