import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { AdminClient } from '../http';
import { json } from '../test/fixtures';
import { InvitationEditor } from './InvitationEditor';
import { MemberEditor } from './MemberEditor';
import { RoleEditor } from './RoleEditor';
import { LinkResult } from './LinkResult';
import { permissionEntries, roleOptions } from './test-fixtures';
const catalog = {
  permissions: permissionEntries,
  assignableRoles: roleOptions,
  writeEnabled: true,
};
const invitation = {
  id: 'invite-1',
  email: 'lin@example.test',
  displayName: 'Lin',
  roles: [roleOptions[0]],
  status: 'pending' as const,
  version: 2,
  expiresAt: '2099-01-01T00:00:00Z',
  createdAt: '2026-09-10T00:00:00Z',
  allowedActions: [],
};
function fixture() {
  const fetcher = vi.fn().mockImplementation(async () =>
    json(
      {
        resourceId: 'saved',
        version: 3,
        link: 'http://localhost:3010/#/reset-password?token=' + 'a'.repeat(43),
      },
      201,
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  return {
    fetcher,
    props: {
      client: new AdminClient(),
      catalog,
      onClose: vi.fn(),
      onChanged: vi.fn(),
      onPermissionsChanged: vi.fn().mockResolvedValue(undefined),
    },
  };
}
function submit(label: string) {
  fireEvent.change(screen.getByLabelText('操作原因'), {
    target: { value: '按已审批的团队岗位调整' },
  });
  fireEvent.click(screen.getByRole('button', { name: label }));
}
it.each([
  ['edit', '保存邀请', 'PATCH', ''],
  ['rotate', '重新生成链接', 'POST', '/rotate'],
  ['revoke', '确认撤销', 'POST', '/revoke'],
] as const)(
  'submits invitation %s with the current version and no email mutation',
  async (action, label, method, suffix) => {
    const { fetcher, props } = fixture();
    render(<InvitationEditor invitation={invitation} action={action} {...props} />);
    if (action === 'edit') {
      expect(screen.getByLabelText('工作邮箱')).toHaveAttribute('readonly');
      fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: 'Lin 新名称' } });
    }
    submit(label);
    await waitFor(() => expect(props.onChanged).toHaveBeenCalledTimes(1));
    expect(fetcher.mock.calls[0][0]).toBe('/api/admin/team/invitations/invite-1' + suffix);
    expect(fetcher.mock.calls[0][1].method).toBe(method);
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body.expectedVersion).toBe(2);
    expect(body).not.toHaveProperty('email');
    if (action === 'edit')
      expect(body).toMatchObject({ displayName: 'Lin 新名称', roles: ['support'] });
  },
);
it.each([
  ['enable', '确认启用', '/enable'],
  ['resetPassword', '生成重置链接', '/password-resets'],
] as const)(
  'submits member %s and does not send passwords or MFA state',
  async (action, label, suffix) => {
    const { fetcher, props } = fixture();
    render(
      <MemberEditor
        member={{ ...invitation, status: 'active', activated: true }}
        action={action}
        {...props}
      />,
    );
    submit(label);
    await waitFor(() => expect(props.onChanged).toHaveBeenCalledTimes(1));
    expect(fetcher.mock.calls[0][0]).toBe('/api/admin/team/members/invite-1' + suffix);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      expectedVersion: 2,
      reason: '按已审批的团队岗位调整',
    });
    if (action === 'resetPassword') expect(screen.getByLabelText('一次性链接')).toBeInTheDocument();
  },
);
it.each([
  ['edit', '保存角色', 'PATCH'],
  ['delete', '确认删除', 'DELETE'],
] as const)(
  'submits custom role %s without allowing key mutation',
  async (action, label, method) => {
    const { fetcher, props } = fixture();
    render(
      <RoleEditor
        role={{
          key: 'custom_analyst',
          name: '分析员',
          description: '',
          builtIn: false,
          permissions: ['dashboard.read'],
          version: 2,
          memberCount: 0,
          invitationCount: 0,
          allowedActions: [],
        }}
        action={action}
        {...props}
      />,
    );
    if (action === 'edit') expect(screen.getByLabelText('角色标识')).toHaveAttribute('readonly');
    submit(label);
    await waitFor(() => expect(props.onChanged).toHaveBeenCalledTimes(1));
    expect(fetcher.mock.calls[0][0]).toBe('/api/admin/team/roles/custom_analyst');
    expect(fetcher.mock.calls[0][1].method).toBe(method);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).not.toHaveProperty('key');
  },
);
it('refreshes authorization on a forbidden mutation without claiming success', async () => {
  const { fetcher, props } = fixture();
  fetcher.mockImplementation(async () => json(null, 403));
  render(<InvitationEditor action="revoke" invitation={invitation} {...props} />);
  submit('确认撤销');
  await waitFor(() => expect(props.onPermissionsChanged).toHaveBeenCalledTimes(1));
  expect(props.onChanged).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent('当前账号没有此操作权限');
});

it('preserves an editable create-role draft after a duplicate key conflict', async () => {
  const { fetcher, props } = fixture();
  fetcher.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          data: null,
          code: 'ADMIN_ROLE_KEY_EXISTS',
          message: 'internal',
          requestId: 'test',
        }),
        { status: 409 },
      ),
  );
  render(<RoleEditor action="create" {...props} />);
  fireEvent.change(screen.getByLabelText('角色名称'), { target: { value: '分析员' } });
  fireEvent.change(screen.getByLabelText('角色标识'), { target: { value: 'custom_existing' } });
  submit('创建角色');
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('角色标识已存在'));
  expect(screen.getByLabelText('角色标识')).toBeEnabled();
  expect(screen.getByLabelText('角色名称')).toHaveValue('分析员');
});
it('requires explicit cancellation and never submits on closing a draft', () => {
  const { fetcher, props } = fixture();
  render(<InvitationEditor action="revoke" invitation={invitation} {...props} />);
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(props.onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '放弃并关闭' }));
  expect(props.onClose).toHaveBeenCalledTimes(1);
  expect(fetcher).not.toHaveBeenCalled();
});
it('falls back to manual copy without persisting a one-time link', async () => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
  });
  render(
    <LinkResult
      result={{
        resourceId: 'invite-1',
        version: 1,
        link: 'http://localhost:3010/#/accept?token=' + 'a'.repeat(43),
      }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: '复制链接' }));
  expect(await screen.findByText('自动复制不可用，请选中上方链接手动复制')).toBeInTheDocument();
  expect(localStorage.length + sessionStorage.length).toBe(0);
});
it('explains sanitized idempotent link replay without presenting a fabricated link', () => {
  render(<LinkResult result={{ resourceId: 'invite-1', version: 1, linkUnavailable: true }} />);
  expect(screen.getByText(/一次性链接不能再次读取/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '复制链接' })).not.toBeInTheDocument();
});
