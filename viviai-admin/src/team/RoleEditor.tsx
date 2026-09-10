import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import type { AdminClient } from '../http';
import type { PermissionCatalog, TeamRole } from './contracts';
import { ActionForm } from './ActionForm';
import { FormField, type FieldErrors } from './FormField';

export function RoleEditor({
  role,
  action,
  catalog,
  client,
  onClose,
  onChanged,
  onPermissionsChanged,
}: {
  role?: TeamRole;
  action: 'create' | 'edit' | 'delete' | 'view';
  catalog: PermissionCatalog;
  client: AdminClient;
  onClose: () => void;
  onChanged: () => void;
  onPermissionsChanged: () => Promise<void>;
}) {
  const [name, setName] = useState(role?.name ?? '');
  const [key, setKey] = useState(role?.key ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [permissions, setPermissions] = useState(role?.permissions ?? ['dashboard.read']);
  const [baselinePermissions, setBaselinePermissions] = useState(
    role?.permissions ?? ['dashboard.read'],
  );
  const [impact, setImpact] = useState({
    members: role?.memberCount ?? 0,
    invitations: role?.invitationCount ?? 0,
  });
  const permissionsChanged =
    [...permissions].sort().join(',') !== [...baselinePermissions].sort().join(',');
  const available = catalog.permissions.filter((p) => p.customRoleAllowed);
  function toggle(key: string, checked: boolean) {
    const next = new Set(permissions);
    if (checked) {
      const add = (permission: string) => {
        if (next.has(permission)) return;
        next.add(permission);
        available.find((p) => p.key === permission)?.dependencies.forEach(add);
      };
      add(key);
    } else {
      next.delete(key);
      let changed = true;
      while (changed) {
        changed = false;
        for (const permission of available)
          if (next.has(permission.key) && permission.dependencies.some((dep) => !next.has(dep))) {
            next.delete(permission.key);
            changed = true;
          }
      }
    }
    next.add('dashboard.read');
    setPermissions([...next]);
  }
  if (action === 'view')
    return (
      <Sheet
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <SheetContent className="team-sheet" showCloseButton={false}>
          <SheetHeader>
            <SheetTitle>{role?.name}</SheetTitle>
            <SheetDescription>
              {role?.builtIn ? '内置角色受保护，仅可查看' : '自定义角色权限详情'}
            </SheetDescription>
          </SheetHeader>
          <div className="team-sheet-body stack">
            <p>{role?.description || '暂无角色说明'}</p>
            <ul className="team-permission-list">
              {role?.permissions.map((key) => (
                <li key={key}>{catalog.permissions.find((p) => p.key === key)?.name ?? key}</li>
              ))}
            </ul>
            <Button variant="outline" onClick={onClose}>
              关闭
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    );
  const create = action === 'create';
  const remove = action === 'delete';
  return (
    <ActionForm
      client={client}
      title={create ? '新增角色' : remove ? '删除角色' : '编辑角色'}
      description={
        remove
          ? '仅未被成员或有效邀请使用的自定义角色可以删除。'
          : '自定义角色仅开放当前业务查询与数据范围权限；不包含团队写权限或客户敏感内容。'
      }
      submitLabel={create ? '创建角色' : remove ? '确认删除' : '保存角色'}
      successText={create ? '角色已创建' : remove ? '角色已删除' : '角色已更新'}
      method={create ? 'POST' : remove ? 'DELETE' : 'PATCH'}
      path={create ? '/team/roles' : `/team/roles/${encodeURIComponent(role!.key)}`}
      initialVersion={role?.version}
      payload={() =>
        remove
          ? {}
          : {
              ...(create ? { key: key.trim() } : {}),
              name: name.trim(),
              description: description.trim(),
              permissions,
            }
      }
      validate={() => {
        if (remove) return;
        const errors: FieldErrors = {};
        if (!name.trim() || name.trim().length > 80) errors.name = '角色名称需为 1–80 个字符';
        if (create && (!/^custom_[a-z0-9_]+$/.test(key.trim()) || key.trim().length > 64))
          errors.key = '角色标识需以 custom_ 开头，仅使用小写字母、数字和下划线，最多 64 字符';
        if (description.trim().length > 500) errors.description = '角色说明最多 500 个字符';
        return errors;
      }}
      onReload={
        role
          ? async () => {
              const latest = await client.get<TeamRole>(
                `/team/roles/${encodeURIComponent(role.key)}`,
              );
              setImpact({ members: latest.memberCount, invitations: latest.invitationCount });
              setBaselinePermissions(latest.permissions);
              return {
                version: latest.version,
                summary: `${latest.name} · ${latest.permissions.map((k) => catalog.permissions.find((p) => p.key === k)?.name ?? k).join('、')}`,
              };
            }
          : undefined
      }
      onClose={onClose}
      onChanged={onChanged}
      onPermissionsChanged={onPermissionsChanged}
    >
      {!create && (
        <div className="notices">
          <p>
            关联 {impact.members} 位成员、{impact.invitations} 个有效邀请。
          </p>
          {!remove && (
            <p>
              {permissionsChanged
                ? `保存后将撤销 ${impact.members} 位成员的旧会话和验证挑战；未消费邀请激活时将使用更新后的权限。`
                : '仅修改名称或说明不会撤销会话；权限变更后成员需重新登录。'}
            </p>
          )}
        </div>
      )}
      {remove ? (
        <p className="notices">即将删除「{role?.name}」。历史审计将保留。</p>
      ) : (
        <>
          <FormField name="name" label="角色名称">
            <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </FormField>
          <FormField name="key" label="角色标识">
            <Input
              value={key}
              maxLength={64}
              readOnly={!create}
              onChange={(e) => setKey(e.target.value)}
              placeholder="custom_analyst"
            />
          </FormField>
          <FormField name="description" label="角色说明">
            <Textarea
              value={description}
              maxLength={500}
              onChange={(e) => setDescription(e.target.value)}
            />
          </FormField>
          <fieldset className="team-choices">
            <legend>查询权限与数据范围</legend>
            <p className="caption">勾选权限会自动包含依赖权限；取消基础权限会同步取消依赖项。</p>
            {[...new Set(available.map((p) => p.module))].map((module) => (
              <div className="team-permission-group" key={module}>
                <h3>{module}</h3>
                {available
                  .filter((p) => p.module === module)
                  .map((permission) => (
                    <label className="team-choice" key={permission.key}>
                      <input
                        type="checkbox"
                        aria-label={permission.name}
                        checked={permissions.includes(permission.key)}
                        disabled={permission.key === 'dashboard.read'}
                        onChange={(e) => toggle(permission.key, e.target.checked)}
                      />
                      <span>
                        {permission.name}
                        {permission.key === 'dashboard.read' && <small>必选基础权限</small>}
                      </span>
                    </label>
                  ))}
              </div>
            ))}
          </fieldset>
        </>
      )}
    </ActionForm>
  );
}
