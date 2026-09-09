import { useEffect, useState, type CSSProperties } from 'react';
import {
  Activity,
  CreditCard,
  Users,
  ListChecks,
  Layers,
  Network,
  Bell,
  ScrollText,
  Shield,
  LayoutDashboard,
  LogOut,
  RefreshCw,
  ArrowLeft,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import type { AdminActor, Dashboard } from './contracts';
import { AdminClient } from './http';
import { Brand } from './AuthScreen';
import { availableNavigation, navigation, roleLabels, routePermission } from './navigation';
import { safeRoute } from './format';
import { ResourcePage } from './ResourcePage';
import { DashboardPage } from './DashboardPage';
import { DetailPage } from './DetailPage';
import { useAdminQuery } from './useQuery';

const icons = [
  LayoutDashboard,
  Users,
  CreditCard,
  ListChecks,
  Layers,
  Network,
  Bell,
  ScrollText,
  Users,
  Shield,
];
export function ConsoleShell({
  actor,
  client,
  environment,
  onLogout,
}: {
  actor: AdminActor;
  client: AdminClient;
  environment: string;
  onLogout: () => void;
}) {
  const initial = availableNavigation(actor)[0]?.path ?? '/dashboard';
  const [path, setPath] = useState(initial);
  useEffect(() => {
    const update = () => setPath(safeRoute(window.location.hash.slice(1)) ?? initial);
    update();
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, [initial]);
  const root = `/${path.split('/')[1]}`;
  const title = navigation.find((item) => item.path === root)?.label ?? '调用详情';
  const permission = routePermission(path);
  const allowed = permission && actor.permissions.includes(permission);
  const detail = path.split('/').length > 2;
  return (
    <SidebarProvider style={{ '--sidebar-width': '224px' } as CSSProperties}>
      <Sidebar collapsible="offcanvas">
        <SidebarHeader className="console-brand">
          <Brand />
        </SidebarHeader>
        <TeamNavigation actor={actor} path={path} />
        <SidebarFooter className="console-profile">
          <span className="profile-avatar">{actor.displayName.slice(0, 1)}</span>
          <div className="profile-details">
            <strong>{actor.displayName}</strong>
            <span>{actor.roles.map((role) => roleLabels[role] ?? role).join(' / ')}</span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="退出登录"
            title="退出登录"
            onClick={onLogout}
          >
            <LogOut size={17} />
          </Button>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>
        <header className="console-topbar">
          <div>
            <SidebarTrigger aria-label="切换导航" />
            <span>运营工作台</span>
            <span className="breadcrumb-divider">/</span>
            <strong>{title}</strong>
          </div>
          <span className="environment">{environment} · 只读查询 A</span>
        </header>
        <div className="console-content">
          <div className="page-heading">
            <div>
              <p className="eyebrow">{detail ? 'RECORD DETAIL' : 'OPERATIONS / READ ONLY'}</p>
              <h1>{detail ? `${title}详情` : title}</h1>
              <p>
                {detail
                  ? '关联记录、时间与状态统一追溯。'
                  : root === '/dashboard'
                    ? '只展示当前角色可见的真实业务数据。'
                    : '精确定位业务记录，所有查询均受权限与审计保护。'}
              </p>
            </div>
            {detail && root !== '/attempts' && (
              <a className="back-link" href={`#${root}`}>
                <ArrowLeft size={16} />
                返回列表
              </a>
            )}
          </div>
          {!allowed ? (
            <section className="panel empty-state">
              <Shield size={24} />
              <h2>当前账号无权查看此页面</h2>
              <p>请从左侧已授权的菜单继续操作。</p>
            </section>
          ) : detail ? (
            <DetailPage key={path} path={path} client={client} permissions={actor.permissions} />
          ) : root === '/dashboard' ? (
            <DashboardQuery client={client} permissions={actor.permissions} />
          ) : (
            <ResourcePage path={path} client={client} permissions={actor.permissions} />
          )}
          <footer className="console-footer">
            <span>
              <Activity size={13} /> VIVIAI 内部运营平台
            </span>
            <span>数据时间：Asia/Shanghai · 高风险写操作尚未开放</span>
          </footer>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
function TeamNavigation({ actor, path }: { actor: AdminActor; path: string }) {
  const items = availableNavigation(actor);
  const { setOpenMobile } = useSidebar();
  return (
    <SidebarContent>
      <nav aria-label="运营导航">
        {['工作台', '业务查询', '模型运行', '团队安全'].map(
          (group) =>
            items.some((item) => item.group === group) && (
              <SidebarGroup key={group}>
                <SidebarGroupLabel>{group}</SidebarGroupLabel>
                <SidebarMenu>
                  {items
                    .filter((item) => item.group === group)
                    .map((item) => {
                      const Icon = icons[navigation.indexOf(item)];
                      return (
                        <SidebarMenuItem key={item.path}>
                          <SidebarMenuButton
                            className="nav-item"
                            render={<a href={`#${item.path}`} />}
                            isActive={path === item.path || path.startsWith(`${item.path}/`)}
                            onClick={() => setOpenMobile(false)}
                          >
                            <Icon />
                            <span>{item.label}</span>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      );
                    })}
                </SidebarMenu>
              </SidebarGroup>
            ),
        )}
      </nav>
    </SidebarContent>
  );
}
function DashboardQuery({ client, permissions }: { client: AdminClient; permissions: string[] }) {
  const [revision, setRevision] = useState(0);
  const query = useAdminQuery<Dashboard>(client, '/dashboard', revision);
  return (
    <>
      <div className="dashboard-toolbar">
        <span className="caption">按需刷新 · 不以后台轮询延长闲置会话</span>
        <Button
          variant="outline"
          disabled={query.loading}
          onClick={() => setRevision((n) => n + 1)}
        >
          <RefreshCw size={15} />
          刷新数据
        </Button>
      </div>
      {query.loading ? (
        <div className="panel loading-state" role="status">
          正在汇总业务数据…
        </div>
      ) : query.error ? (
        <p className="error-banner" role="alert">
          {query.error}
        </p>
      ) : (
        query.data && <DashboardPage dashboard={query.data} permissions={permissions} />
      )}
    </>
  );
}
