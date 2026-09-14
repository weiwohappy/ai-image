'use client';

import { Navigate, Route, Routes } from 'react-router-dom';

import { AppShell } from '@/src/components/shell/AppShell';
import { CreatePage } from '@/src/features/generation/CreatePage';
import { AuthPage } from '@/src/features/auth/AuthPage';
import { AssetsPage } from '@/src/features/assets/AssetsPage';
import { InspirationPage } from '@/src/features/inspiration/InspirationPage';
import { RemixPage } from '@/src/features/remix/RemixPage';
import { RemixLibraryPage } from '@/src/features/remix/RemixLibraryPage';
import { ToolRunPage } from '@/src/features/tools/ToolRunPage';
import { ToolsPage } from '@/src/features/tools/ToolsPage';
import { TasksPage } from '@/src/features/tasks/TasksPage';
import { WorkflowEditorPage } from '@/src/features/workflows/WorkflowEditorPage';
import { WorkflowsPage } from '@/src/features/workflows/WorkflowsPage';
import { AccountPage } from '@/src/features/account/AccountPage';
import { PricingPage } from '@/src/features/billing/PricingPage';
import { InvitePage } from '@/src/features/invite/InvitePage';
import { ProtectedRoute } from './ProtectedRoute';
import { isRealApi } from '@/src/services/api';
import { RealApiUnavailablePage } from '@/src/features/system/RealApiUnavailablePage';

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<AuthPage mode="login" />} />
      <Route path="/register" element={<AuthPage mode="register" />} />
      <Route path="/forgot-password" element={<AuthPage mode="forgot" />} />
      <Route element={<AppShell />}>
        <Route path="/create" element={<CreatePage />} />
        <Route path="/inspiration" element={isRealApi() ? <RealApiUnavailablePage title="灵感发现暂未接入真实接口" /> : <InspirationPage />} />
        <Route path="/remix" element={<RemixPage />} />
        <Route path="/remix/templates" element={isRealApi() ? <RealApiUnavailablePage title="爆款模板库暂未接入真实接口" /> : <RemixLibraryPage />} />
        <Route path="/remix/:templateId" element={isRealApi() ? <RealApiUnavailablePage title="平台模板暂未接入真实接口" /> : <RemixPage />} />
        <Route path="/assets" element={<ProtectedRoute><AssetsPage /></ProtectedRoute>} />
        <Route path="/tools" element={<ProtectedRoute><ToolsPage /></ProtectedRoute>} />
        <Route path="/tools/:toolId" element={<ProtectedRoute><ToolRunPage /></ProtectedRoute>} />
        <Route path="/workflows" element={<ProtectedRoute><WorkflowsPage /></ProtectedRoute>} />
        <Route path="/workflows/:workflowId" element={<ProtectedRoute><WorkflowEditorPage /></ProtectedRoute>} />
        <Route path="/tasks" element={<ProtectedRoute><TasksPage /></ProtectedRoute>} />
        <Route path="/pricing" element={<PricingPage />} />
        <Route path="/account" element={<ProtectedRoute><AccountPage /></ProtectedRoute>} />
        <Route path="/invite" element={<ProtectedRoute><InvitePage /></ProtectedRoute>} />
      </Route>
      <Route path="/" element={<Navigate to="/create" replace />} />
      <Route path="*" element={<Navigate to="/create" replace />} />
    </Routes>
  );
}
