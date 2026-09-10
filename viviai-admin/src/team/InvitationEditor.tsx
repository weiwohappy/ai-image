import { useState } from 'react';
import { Input } from '@/components/ui/input';
import type { AdminClient } from '../http';
import type { PermissionCatalog, TeamAction, TeamInvitation } from './contracts';
import { ActionForm } from './ActionForm';
import { RoleChoices } from './presentation';
export function InvitationEditor({
  invitation,
  action,
  client,
  catalog,
  onClose,
  onChanged,
  onPermissionsChanged,
}: {
  invitation?: TeamInvitation;
  action: TeamAction;
  client: AdminClient;
  catalog: PermissionCatalog;
  onClose: () => void;
  onChanged: () => void;
  onPermissionsChanged: () => Promise<void>;
}) {
  const [email, setEmail] = useState(invitation?.email ?? '');
  const [name, setName] = useState(invitation?.displayName ?? '');
  const [roles, setRoles] = useState(invitation?.roles.map((r) => r.key) ?? []);
  const create = !invitation;
  const edit = action === 'edit';
  const labels = create
    ? ['新增成员', '创建邀请', '邀请已创建，请复制链接发给同事']
    : edit
      ? ['编辑邀请', '保存邀请', '邀请已更新；角色变化后请重新生成链接']
      : action === 'rotate'
        ? ['重新生成邀请', '重新生成链接', '邀请链接已重新生成，旧链接已失效']
        : ['撤销邀请', '确认撤销', '邀请已撤销'];
  return (
    <ActionForm
      client={client}
      title={labels[0]}
      description={
        create
          ? '通过邀请链接加入内部团队，不会自动发送邮件。'
          : `${invitation.displayName}（${invitation.email}）`
      }
      submitLabel={labels[1]}
      successText={labels[2]}
      method={edit ? 'PATCH' : 'POST'}
      path={
        create
          ? '/team/invitations'
          : `/team/invitations/${invitation.id}${edit ? '' : `/${action}`}`
      }
      initialVersion={invitation?.version}
      onClose={onClose}
      onChanged={onChanged}
      onPermissionsChanged={onPermissionsChanged}
      onReload={
        invitation
          ? async () => {
              const page = await client.get<{ items: TeamInvitation[] }>(
                `/team/invitations?q=${encodeURIComponent(invitation.email)}&limit=30`,
              );
              const current = page.items.find((row) => row.id === invitation.id);
              if (!current) throw new Error('Record unavailable');
              return {
                version: current.version,
                summary: `${current.displayName}，${current.roles.map((r) => r.name).join('、')}`,
              };
            }
          : undefined
      }
      validate={() => {
        if (!create && !edit) return;
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return '请填写有效的工作邮箱';
        if (!name.trim()) return '请填写显示名称';
        if (!roles.length) return '请至少选择一个角色';
      }}
      payload={() =>
        create
          ? { email: email.trim().toLowerCase(), displayName: name.trim(), roles }
          : edit
            ? { displayName: name.trim(), roles }
            : {}
      }
    >
      {create || edit ? (
        <>
          <label className="field">
            工作邮箱
            <Input
              type="email"
              value={email}
              maxLength={254}
              readOnly={!create}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="field">
            显示名称
            <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </label>
          <RoleChoices
            roles={catalog.assignableRoles.filter((r) => r.key !== 'super_admin')}
            selected={roles}
            onChange={setRoles}
            permissions={catalog.permissions}
          />
          <p className="notices">
            新成员需自行设置至少 12 位密码并绑定身份验证器。现有两位本地测试账号的简化登录不变。
          </p>
        </>
      ) : (
        <p className="notices">
          {action === 'rotate'
            ? '旧链接将立即失效，新链接有效期为 24 小时。'
            : '该链接将立即失效，受邀人无法继续使用它激活账号。'}
        </p>
      )}
    </ActionForm>
  );
}
