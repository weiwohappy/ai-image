import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { AdminClient } from '../http';
import { RolesPage } from './RolesPage';
import { setupTeamApi, teamActor } from './test-fixtures';

it('creates a custom role including permission dependencies without offering privileged writes', async () => {
  const api = setupTeamApi();
  const user = userEvent.setup();
  render(
    <RolesPage
      actor={teamActor}
      client={new AdminClient()}
      onPermissionsChanged={async () => {}}
    />,
  );
  await user.click(await screen.findByRole('button', { name: '新增角色' }));
  await user.type(screen.getByLabelText('角色名称'), '模型分析员');
  await user.type(screen.getByLabelText('角色标识'), 'custom_analyst');
  await user.click(screen.getByLabelText('模型概览'));
  expect(screen.getByLabelText('模型查询')).toBeChecked();
  expect(screen.queryByLabelText('成员编辑')).not.toBeInTheDocument();
  await user.type(screen.getByLabelText('操作原因'), '建立模型业务查询岗位');
  await user.click(screen.getByRole('button', { name: '创建角色' }));
  await screen.findByText('角色已创建');
  expect((api.commands[0].body.permissions as string[]).sort()).toEqual([
    'dashboard.models.read',
    'dashboard.read',
    'models.read',
  ]);
  await user.click(screen.getByRole('button', { name: '完成' }));
  expect(await screen.findByText('模型分析员')).toBeInTheDocument();
});

it('removes dependent permissions if a resource permission is unchecked', async () => {
  setupTeamApi();
  const user = userEvent.setup();
  render(
    <RolesPage
      actor={teamActor}
      client={new AdminClient()}
      onPermissionsChanged={async () => {}}
    />,
  );
  await user.click(await screen.findByRole('button', { name: '新增角色' }));
  await user.click(screen.getByLabelText('模型概览'));
  await user.click(screen.getByLabelText('模型查询'));
  expect(screen.getByLabelText('模型概览')).not.toBeChecked();
  expect(screen.getByLabelText('工作概览')).toBeChecked();
});

it('allows reading a protected built-in role but never editing or deleting it', async () => {
  setupTeamApi();
  const user = userEvent.setup();
  render(
    <RolesPage
      actor={teamActor}
      client={new AdminClient()}
      onPermissionsChanged={async () => {}}
    />,
  );
  const row = (await screen.findByText('客服')).closest('tr')!;
  expect(within(row).getByRole('button', { name: '编辑' })).toBeDisabled();
  expect(within(row).getByRole('button', { name: '删除' })).toBeDisabled();
  await user.click(within(row).getByRole('button', { name: '查看' }));
  expect(await screen.findByText('内置角色受保护，仅可查看')).toBeInTheDocument();
  expect(screen.getByText('用户查询')).toBeInTheDocument();
  expect(screen.queryByLabelText('操作原因')).not.toBeInTheDocument();
});
