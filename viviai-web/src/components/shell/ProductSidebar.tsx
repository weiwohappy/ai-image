'use client';

import { useQuery } from '@tanstack/react-query';
import { LogIn, UserRound } from 'lucide-react';
import { NavLink, useLocation } from 'react-router-dom';

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar';
import { api } from '@/src/services/api';
import { queryKeys } from '@/src/services/queryKeys';
import { navigationItems } from '@/src/app/useNavigationItems';

export function ProductSidebar() {
  const { data: me } = useQuery({ queryKey: queryKeys.me, queryFn: api.getMe });
  const location = useLocation();

  return (
    <Sidebar collapsible="icon" className="border-sidebar-border bg-sidebar">
      <SidebarHeader className="border-b border-sidebar-border px-3 py-4">
        <NavLink to="/create" className="flex items-center gap-3 overflow-hidden">
          <span className="grid size-10 shrink-0 place-items-center rounded-[14px] bg-primary text-xl font-black text-primary-foreground shadow-[0_0_24px_rgba(216,255,82,.18)]">V</span>
          <span className="min-w-0 leading-tight group-data-[collapsible=icon]:hidden">
            <strong className="block text-base tracking-[-.02em] text-foreground">VIVIAI</strong>
            <span className="text-xs text-muted-foreground">Visual Intelligence</span>
          </span>
        </NavLink>
      </SidebarHeader>
      <SidebarContent className="px-2 py-3">
        <SidebarGroup className="p-0">
          <SidebarGroupContent>
            <SidebarMenu className="gap-1">
              {navigationItems.map(({ to, label, icon: Icon }) => (
                <SidebarMenuItem key={to}>
                  <SidebarMenuButton
                    render={<NavLink to={to} />}
                    isActive={location.pathname === to || (to !== '/create' && location.pathname.startsWith(`${to}/`))}
                    tooltip={label}
                    className="h-11 rounded-xl px-3 text-[14px] data-active:bg-primary data-active:text-primary-foreground data-active:shadow-[0_0_20px_rgba(216,255,82,.12)]"
                  >
                    <Icon />
                    <span>{label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border p-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<NavLink to={me ? '/account' : '/login'} />}
              tooltip={me ? '个人中心' : '登录'}
              className="h-12 rounded-xl bg-sidebar-accent px-3"
            >
              {me ? <UserRound /> : <LogIn />}
              <span className="min-w-0">
                <strong className="block truncate text-sm">{me?.username ?? '登录 VIVIAI'}</strong>
                <span className="block truncate text-xs text-muted-foreground">{me ? `${me.credits.toLocaleString()} 可用积分` : '同步你的创作资产'}</span>
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
