'use client';

import { Navigate, Route, Routes } from 'react-router-dom';

import { AppShell } from '@/src/components/shell/AppShell';
import { CreatePage } from '@/src/features/generation/CreatePage';
import { AuthPage } from '@/src/features/auth/AuthPage';
import { AssetsPage } from '@/src/features/assets/AssetsPage';
import { InspirationPage } from '@/src/features/inspiration/InspirationPage';
import { RemixDetailPage } from '@/src/features/remix/RemixDetailPage';
import { RemixLibraryPage } from '@/src/features/remix/RemixLibraryPage';
import { ToolRunPage } from '@/src/features/tools/ToolRunPage';
import { ToolsPage } from '@/src/features/tools/ToolsPage';
import { PlaceholderPage } from '@/src/features/system/PlaceholderPage';
import { ProtectedRoute } from './ProtectedRoute';

const protectedPage = (title: string, description: string) => (
  <ProtectedRoute>
    <PlaceholderPage title={title} description={description} />
  </ProtectedRoute>
);

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<AuthPage mode="login" />} />
      <Route path="/register" element={<AuthPage mode="register" />} />
      <Route path="/forgot-password" element={<AuthPage mode="forgot" />} />
      <Route element={<AppShell />}>
        <Route path="/create" element={<CreatePage />} />
        <Route path="/inspiration" element={<InspirationPage />} />
        <Route path="/remix" element={<RemixLibraryPage />} />
        <Route path="/remix/:templateId" element={<RemixDetailPage />} />
        <Route path="/assets" element={<ProtectedRoute><AssetsPage /></ProtectedRoute>} />
        <Route path="/tools" element={<ProtectedRoute><ToolsPage /></ProtectedRoute>} />
        <Route path="/tools/:toolId" element={<ProtectedRoute><ToolRunPage /></ProtectedRoute>} />
        <Route path="/workflows" element={protectedPage('工作流', '通过表格批量组织图片生产任务。')} />
        <Route path="/workflows/:workflowId" element={protectedPage('工作流编辑器', '配置任务行、参考图和生成列。')} />
        <Route path="/tasks" element={protectedPage('任务中心', '查看单次和批量任务的执行状态。')} />
        <Route path="/pricing" element={<PlaceholderPage title="套餐与积分" description="按创作量选择合适的套餐。" />} />
        <Route path="/account" element={protectedPage('个人中心', '管理套餐、积分和账户安全。')} />
        <Route path="/invite" element={protectedPage('邀请有礼', '邀请好友一起创作，双方获得积分。')} />
      </Route>
      <Route path="/" element={<Navigate to="/create" replace />} />
      <Route path="*" element={<Navigate to="/create" replace />} />
    </Routes>
  );
}
