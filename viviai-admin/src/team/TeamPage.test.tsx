import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { AdminClient } from '../http';
import { TeamPage } from './TeamPage';
import { setupTeamApi, teamActor, roleOptions } from './test-fixtures';

it('creates a real invitation request and shows a one-time link without claiming email delivery', async () => {
  const api = setupTeamApi();
  const user = userEvent.setup();
  render(
    <TeamPage actor={teamActor} client={new AdminClient()} onPermissionsChanged={async () => {}} />,
  );
  await user.click(await screen.findByRole('button', { name: '新增成员' }));
  await user.type(screen.getByLabelText('工作邮箱'), 'colleague@example.test');
  await user.type(screen.getByLabelText('显示名称'), '新同事');
  await user.click(screen.getByLabelText('客服'));
  await user.type(screen.getByLabelText('操作原因'), '新增客服同事处理咨询');
  await user.click(screen.getByRole('button', { name: '创建邀请' }));
  expect(await screen.findByText('邀请已创建，请复制链接发给同事')).toBeInTheDocument();
  expect((screen.getByLabelText('一次性链接') as HTMLTextAreaElement).value).toContain(
    '#/accept?token=',
  );
  expect(screen.queryByText('邮件已发送')).not.toBeInTheDocument();
  expect(api.commands[0].body).toEqual({
    email: 'colleague@example.test',
    displayName: '新同事',
    roles: ['support'],
    reason: '新增客服同事处理咨询',
  });
  await user.click(screen.getByRole('button', { name: '完成' }));
  await user.click(screen.getByRole('tab', { name: '待激活邀请' }));
  expect(await screen.findByText('colleague@example.test')).toBeInTheDocument();
});

it('edits names, preserves email identity and reads the new member name back', async () => {
  const api = setupTeamApi();
  const user = userEvent.setup();
  render(
    <TeamPage actor={teamActor} client={new AdminClient()} onPermissionsChanged={async () => {}} />,
  );
  const row = (await screen.findByText('客服小林')).closest('tr')!;
  await user.click(within(row).getByRole('button', { name: '编辑' }));
  expect(screen.getByLabelText('工作邮箱')).toHaveAttribute('readonly');
  await user.clear(screen.getByLabelText('显示名称'));
  await user.type(screen.getByLabelText('显示名称'), '客服林同事');
  await user.type(screen.getByLabelText('操作原因'), '统一成员显示名称');
  await user.click(screen.getByRole('button', { name: '保存名称' }));
  expect(await screen.findByText('成员名称已更新')).toBeInTheDocument();
  expect(api.commands[0].method).toBe('PATCH');
  expect(api.commands[0].body).not.toHaveProperty('email');
  await user.click(screen.getByRole('button', { name: '完成' }));
  expect(await screen.findByText('客服林同事')).toBeInTheDocument();
});

it('requires a reason and selected role before issuing invitations', async () => {
  const api = setupTeamApi();
  const user = userEvent.setup();
  render(
    <TeamPage actor={teamActor} client={new AdminClient()} onPermissionsChanged={async () => {}} />,
  );
  await user.click(await screen.findByRole('button', { name: '新增成员' }));
  await user.type(screen.getByLabelText('工作邮箱'), 'colleague@example.test');
  await user.type(screen.getByLabelText('显示名称'), '同事');
  await user.type(screen.getByLabelText('操作原因'), '新增同事账号');
  await user.click(screen.getByRole('button', { name: '创建邀请' }));
  expect(await screen.findByText('请至少选择一个角色')).toBeInTheDocument();
  expect(api.commands).toHaveLength(0);
});

it('keeps inputs after a version conflict and requires loading the latest version', async () => {
  const api = setupTeamApi({ failOnce: 409 });
  const user = userEvent.setup();
  render(
    <TeamPage actor={teamActor} client={new AdminClient()} onPermissionsChanged={async () => {}} />,
  );
  await user.click(
    within((await screen.findByText('客服小林')).closest('tr')!).getByRole('button', {
      name: '编辑',
    }),
  );
  await user.clear(screen.getByLabelText('显示名称'));
  await user.type(screen.getByLabelText('显示名称'), '保留的草稿');
  await user.type(screen.getByLabelText('操作原因'), '调整客服显示名称');
  await user.click(screen.getByRole('button', { name: '保存名称' }));
  expect(await screen.findByRole('button', { name: '加载最新记录' })).toBeInTheDocument();
  expect(screen.getByLabelText('显示名称')).toHaveValue('保留的草稿');
  expect(screen.getByRole('button', { name: '保存名称' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: '加载最新记录' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '保存名称' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: '保存名称' }));
  await screen.findByText('成员名称已更新');
  expect(api.commands[1].body.expectedVersion).toBe(2);
  expect(api.commands[1].key).not.toBe(api.commands[0].key);
});

it('freezes an unknown submission and retries exactly the same idempotency key', async () => {
  const api = setupTeamApi({ loseOnce: true });
  const user = userEvent.setup();
  render(
    <TeamPage actor={teamActor} client={new AdminClient()} onPermissionsChanged={async () => {}} />,
  );
  await user.click(
    within((await screen.findByText('客服小林')).closest('tr')!).getByRole('button', {
      name: '禁用',
    }),
  );
  await user.type(screen.getByLabelText('操作原因'), '员工离岗暂停访问');
  await user.click(screen.getByRole('button', { name: '确认禁用' }));
  expect(await screen.findByText(/结果未确认/)).toBeInTheDocument();
  expect(screen.getByLabelText('操作原因')).toBeDisabled();
  await user.click(screen.getByRole('button', { name: '重试同一操作' }));
  await screen.findByText('成员已禁用');
  expect(api.commands).toHaveLength(2);
  expect(api.commands[1]).toEqual(api.commands[0]);
});

it('uses action availability to protect own account and exposes an unavailable reason', async () => {
  setupTeamApi({ protectedMember: true });
  render(
    <TeamPage actor={teamActor} client={new AdminClient()} onPermissionsChanged={async () => {}} />,
  );
  const row = (await screen.findByText('客服小林')).closest('tr')!;
  expect(within(row).getByRole('button', { name: '禁用' })).toBeDisabled();
  expect(within(row).getByText('不能对本人执行此操作')).toBeInTheDocument();
});

it('submits the full selected role set and explains session revocation', async () => {
  const api = setupTeamApi();
  const user = userEvent.setup();
  render(
    <TeamPage actor={teamActor} client={new AdminClient()} onPermissionsChanged={async () => {}} />,
  );
  await user.click(
    within((await screen.findByText('客服小林')).closest('tr')!).getByRole('button', {
      name: '分配角色',
    }),
  );
  expect(screen.getByText(/重新登录后生效/)).toBeInTheDocument();
  await user.click(screen.getByLabelText(roleOptions[1].name));
  await user.type(screen.getByLabelText('操作原因'), '同时负责模型查询');
  await user.click(screen.getByRole('button', { name: '保存角色' }));
  await screen.findByText('成员角色已更新');
  expect(api.commands[0].body.roles).toEqual(['support', 'model_operator']);
  expect(api.commands[0].method).toBe('PUT');
});

it('hides writes when the environment does not enable team commands and can search by exact email', async () => {
  const api = setupTeamApi({ writeEnabled: false });
  render(
    <TeamPage actor={teamActor} client={new AdminClient()} onPermissionsChanged={async () => {}} />,
  );
  expect(await screen.findByText('当前环境未开放团队写操作')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '新增成员' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('精确邮箱查询'), {
    target: { value: 'lin@example.test' },
  });
  fireEvent.click(screen.getByRole('button', { name: '查询' }));
  await waitFor(() =>
    expect(api.requests.some((path) => path.includes('q=lin%40example.test'))).toBe(true),
  );
});
