'use client';

import { Outlet } from 'react-router-dom';

import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { ProductSidebar } from './ProductSidebar';
import { Topbar } from './Topbar';

export function AppShell() {
  return (
    <SidebarProvider defaultOpen>
      <ProductSidebar />
      <SidebarInset className="min-w-0 bg-background">
        <Topbar />
        <div className="min-h-0 flex-1 overflow-auto">
          <Outlet />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
