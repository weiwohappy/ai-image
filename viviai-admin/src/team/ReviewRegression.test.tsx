import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { AdminClient } from '../http';
import { json } from '../test/fixtures';
import { TeamPage } from './TeamPage';
import { RolesPage } from './RolesPage';
import { RoleEditor } from './RoleEditor';
import { MemberEditor } from './MemberEditor';
import { InvitationEditor } from './InvitationEditor';
import { permissionEntries, roleOptions, teamActor } from './test-fixtures';
const catalog = {
  permissions: permissionEntries,
  assignableRoles: roleOptions,
  writeEnabled: true,
};
const page = { items: [], nextCursor: null, asOf: '2026-09-10T00:00:00Z', allowedActions: [] };
const props = () => ({
  actor: teamActor,
  client: new AdminClient(),
  onPermissionsChanged: vi.fn().mockResolvedValue(undefined),
});
it('honors server-denied create actions even when actor grants and environment allow writes', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => json(url.endsWith('permission-catalog') ? catalog : page)),
  );
  render(<TeamPage {...props()} />);
  await screen.findByText('没有符合条件的成员记录');
  expect(screen.getByRole('button', { name: '新增成员' })).toBeDisabled();
});
it.each([
  { Page: TeamPage, resource: '团队记录', empty: '成员记录' },
  { Page: RolesPage, resource: '角色', empty: '角色' },
])('renders loading, empty and error states for $resource', async ({ Page, resource, empty }) => {
  let mode = 'loading';
  let finish!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.endsWith('permission-catalog')
        ? json(catalog)
        : mode === 'loading'
          ? new Promise<Response>((resolve) => {
              finish = resolve;
            })
          : json(null, 503),
    ),
  );
  render(<Page {...props()} />);
  expect(screen.getByRole('status')).toHaveTextContent(`正在读取${resource}`);
  await waitFor(() => expect(finish).toBeDefined());
  finish(json(page));
  await screen.findByText(new RegExp(`没有符合条件的${empty}`));
  mode = 'error';
  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('服务暂时不可用');
});
it('shows a last-super denial as unavailable action with its server reason', async () => {
  const member = {
    id: 'last',
    email: 'last@example.test',
    displayName: '最后管理员',
    roles: roleOptions,
    status: 'active',
    activated: true,
    version: 1,
    createdAt: page.asOf,
    allowedActions: [{ action: 'disable', allowed: false, reasonCode: 'ADMIN_LAST_SUPER_ADMIN' }],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      json(url.endsWith('permission-catalog') ? catalog : { ...page, items: [member] }),
    ),
  );
  render(<TeamPage {...props()} />);
  expect(await screen.findByText('必须保留一位可登录的超级管理员')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '禁用' })).toBeDisabled();
});
it('shows role edit member/invitation counts and differentiates permission from name-only impact', () => {
  render(
    <RoleEditor
      {...props()}
      catalog={catalog}
      action="edit"
      role={{
        key: 'custom_analyst',
        name: '分析员',
        builtIn: false,
        description: '',
        permissions: ['dashboard.read'],
        version: 1,
        memberCount: 3,
        invitationCount: 2,
        allowedActions: [],
      }}
      onClose={vi.fn()}
      onChanged={vi.fn()}
    />,
  );
  expect(screen.getByText(/关联 3 位成员、2 个有效邀请/)).toBeInTheDocument();
  expect(screen.getByText(/仅修改名称或说明不会撤销会话/)).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText('模型查询'));
  expect(screen.getByText(/保存后将撤销 3 位成员的旧会话/)).toBeInTheDocument();
});
it('shows target roles in disable confirmation', () => {
  render(
    <MemberEditor
      {...props()}
      catalog={catalog}
      action="disable"
      member={{
        id: 'm',
        email: 'lin@example.test',
        displayName: 'Lin',
        roles: roleOptions,
        status: 'active',
        activated: true,
        version: 1,
        createdAt: page.asOf,
        allowedActions: [],
      }}
      onClose={vi.fn()}
      onChanged={vi.fn()}
    />,
  );
  expect(screen.getByText('客服')).toBeInTheDocument();
  expect(screen.getByText('模型运营')).toBeInTheDocument();
});
it('associates validation errors with each invalid field and prevents a command', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  render(
    <InvitationEditor
      {...props()}
      catalog={catalog}
      action="create"
      onClose={vi.fn()}
      onChanged={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: '创建邀请' }));
  const email = screen.getByLabelText('工作邮箱');
  expect(email).toHaveAttribute('aria-invalid', 'true');
  expect(email).toHaveAccessibleDescription('请填写有效的工作邮箱');
  expect(screen.getByLabelText('显示名称')).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByLabelText('操作原因')).toHaveAccessibleDescription(
    '操作原因需为 5–500 个字符',
  );
  expect(fetcher).not.toHaveBeenCalled();
});
