'use client';

import { Navigate, Route, Routes } from 'react-router-dom';

import { AppShell } from '@/src/components/shell/AppShell';
import { CreatePreviewPage } from '@/src/features/generation/CreatePreviewPage';
import { AuthPage } from '@/src/features/auth/AuthPage';
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
        <Route path="/create" element={<CreatePreviewPage />} />
        <Route path="/inspiration" element={<PlaceholderPage title="灵感发现" description="从经过筛选的优秀作品开始创作。" />} />
        <Route path="/remix" element={<PlaceholderPage title="爆款复刻" description="借鉴成熟视觉方法，生成属于你的新作品。" />} />
        <Route path="/remix/:templateId" element={<PlaceholderPage title="模板详情" description="查看视觉结构并开始改编。" />} />
        <Route path="/assets" element={protectedPage('我的资产', '管理生成、复刻、工具与工作流产出的图片。')} />
        <Route path="/tools" element={protectedPage('工具中心', '使用预设能力快速完成常见图片任务。')} />
        <Route path="/tools/:toolId" element={protectedPage('工具执行', '配置素材与参数，生成处理结果。')} />
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
