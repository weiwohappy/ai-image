import { useState } from 'react';
import { Input } from '@/components/ui/input';
import type { AdminClient } from '../http';
import type { PermissionCatalog, TeamAction, TeamMember } from './contracts';
import { ActionForm } from './ActionForm';
import { RoleChoices } from './presentation';
export function MemberEditor({
  member,
  action,
  client,
  catalog,
  onClose,
  onChanged,
  onPermissionsChanged,
}: {
  member: TeamMember;
  action: TeamAction;
  client: AdminClient;
  catalog: PermissionCatalog;
  onClose: () => void;
  onChanged: () => void;
  onPermissionsChanged: () => Promise<void>;
}) {
  const [name, setName] = useState(member.displayName);
  const [roles, setRoles] = useState(member.roles.map((r) => r.key));
  const settings =
    action === 'edit'
      ? {
          title: '编辑成员',
          submit: '保存名称',
          success: '成员名称已更新',
          method: 'PATCH' as const,
          suffix: '',
        }
      : action === 'assignRoles'
        ? {
            title: '分配角色',
            submit: '保存角色',
            success: '成员角色已更新',
            method: 'PUT' as const,
            suffix: '/roles',
          }
        : action === 'disable'
          ? {
              title: '禁用成员',
              submit: '确认禁用',
              success: '成员已禁用',
              method: 'POST' as const,
              suffix: '/disable',
            }
          : action === 'enable'
            ? {
                title: '启用成员',
                submit: '确认启用',
                success: '成员已启用',
                method: 'POST' as const,
                suffix: '/enable',
              }
            : {
                title: '重置成员密码',
                submit: '生成重置链接',
                success: '重置链接已生成，请私下发给本人',
                method: 'POST' as const,
                suffix: '/password-resets',
              };
  const choices = [
    ...catalog.assignableRoles,
    ...member.roles.filter((r) => !catalog.assignableRoles.some((c) => c.key === r.key)),
  ];
  return (
    <ActionForm
      client={client}
      title={settings.title}
      description={`${member.displayName}（${member.email}）`}
      submitLabel={settings.submit}
      successText={settings.success}
      method={settings.method}
      path={`/team/members/${member.id}${settings.suffix}`}
      initialVersion={member.version}
      onClose={onClose}
      onChanged={onChanged}
      onPermissionsChanged={onPermissionsChanged}
      onReload={async () => {
        const next = await client.get<TeamMember>(`/team/members/${member.id}`);
        return {
          version: next.version,
          summary: `${next.displayName}，${next.roles.map((r) => r.name).join('、')}`,
        };
      }}
      validate={() =>
        action === 'edit' && !name.trim()
          ? '请填写显示名称'
          : action === 'assignRoles' && !roles.length
            ? '请至少选择一个角色'
            : undefined
      }
      payload={() =>
        action === 'edit' ? { displayName: name.trim() } : action === 'assignRoles' ? { roles } : {}
      }
    >
      <label className="field">
        工作邮箱
        <Input readOnly value={member.email} />
      </label>
      {action === 'edit' && (
        <label className="field">
          显示名称
          <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </label>
      )}
      {action === 'assignRoles' && (
        <>
          <p className="notices">
            原角色：{member.roles.map((r) => r.name).join('、')}
            。保存后将撤销旧会话，重新登录后生效。
          </p>
          <RoleChoices
            roles={choices}
            selected={roles}
            onChange={setRoles}
            permissions={catalog.permissions}
          />
        </>
      )}
      {action === 'disable' && (
        <p className="notices">
          将立即停止该成员访问并撤销所有登录会话，业务数据和审计记录会保留。
        </p>
      )}
      {action === 'enable' && (
        <p className="notices">成员可重新登录；尚未完成的身份验证仍需完成，旧会话不会恢复。</p>
      )}
      {action === 'resetPassword' && (
        <p className="notices">
          将撤销该成员当前会话，生成 30 分钟有效的设密链接。不会修改身份验证器或直接设置默认密码。
        </p>
      )}
    </ActionForm>
  );
}
