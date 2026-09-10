import { useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableHeader,
  TableHead,
  TableRow,
  TableBody,
  TableCell,
} from '@/components/ui/table';
import type { AdminActor } from '../contracts';
import type { AdminClient } from '../http';
import { useAdminQuery } from '../useQuery';
import type { TeamList, TeamRole, PermissionCatalog } from './contracts';
import { ActionButton, canAct, TeamPagination } from './presentation';
import { RoleEditor } from './RoleEditor';

export function RolesPage({
  actor,
  client,
  onPermissionsChanged,
}: {
  actor: AdminActor;
  client: AdminClient;
  onPermissionsChanged: () => Promise<void>;
}) {
  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  const [cursors, setCursors] = useState(['']);
  const [revision, setRevision] = useState(0);
  const [editor, setEditor] = useState<{
    role?: TeamRole;
    action: 'create' | 'edit' | 'delete' | 'view';
  }>();
  const catalog = useAdminQuery<PermissionCatalog>(client, '/team/permission-catalog');
  const query = useAdminQuery<TeamList<TeamRole>>(
    client,
    `/team/roles?limit=30${q ? `&q=${encodeURIComponent(q)}` : ''}${cursors.at(-1) ? `&cursor=${encodeURIComponent(cursors.at(-1)!)}` : ''}`,
    revision,
  );
  const write = catalog.data?.writeEnabled === true;
  const refresh = () => setRevision((n) => n + 1);
  return (
    <div className="team-page">
      <div className="team-page-toolbar">
        <p className="caption">内置岗位固定保护，自定义角色按业务查询范围授权。</p>
        <Button
          disabled={
            !write ||
            !actor.permissions.includes('roles.create') ||
            !canAct(query.data?.allowedActions ?? [], 'create')
          }
          onClick={() => setEditor({ action: 'create' })}
        >
          <Plus size={16} />
          新增角色
        </Button>
      </div>
      {catalog.data && !write && <p className="notices">当前环境未开放团队写操作</p>}
      {catalog.error && (
        <p className="error-banner" role="alert">
          {catalog.error}
        </p>
      )}
      <section className="panel">
        <form
          className="query-toolbar"
          onSubmit={(event) => {
            event.preventDefault();
            setQ(draft.trim());
            setCursors(['']);
            refresh();
          }}
        >
          <Input
            className="team-search"
            aria-label="角色查询"
            placeholder="精确输入角色标识"
            maxLength={64}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button type="submit" disabled={query.loading}>
            查询
          </Button>
          <Button type="button" variant="outline" disabled={query.loading} onClick={refresh}>
            <RefreshCw size={15} />
            刷新
          </Button>
        </form>
        {query.loading ? (
          <p className="loading-state" role="status">
            正在读取角色…
          </p>
        ) : query.error ? (
          <p className="error-banner" role="alert">
            {query.error}
          </p>
        ) : !query.data?.items.length ? (
          <p className="empty-state">没有符合条件的角色</p>
        ) : (
          <Table className="team-table">
            <TableHeader>
              <TableRow>
                <TableHead>角色</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>权限</TableHead>
                <TableHead>关联成员 / 有效邀请</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.data.items.map((role) => (
                <TableRow key={role.key}>
                  <TableCell>
                    <strong>{role.name}</strong>
                    <small className="team-email">{role.key}</small>
                  </TableCell>
                  <TableCell>{role.builtIn ? '内置' : '自定义'}</TableCell>
                  <TableCell>
                    <span
                      title={role.permissions
                        .map(
                          (key) =>
                            catalog.data?.permissions.find((p) => p.key === key)?.name ?? key,
                        )
                        .join('、')}
                    >
                      {role.permissions
                        .slice(0, 3)
                        .map(
                          (key) =>
                            catalog.data?.permissions.find((p) => p.key === key)?.name ?? key,
                        )
                        .join('、')}
                      {role.permissions.length > 3 ? ` 等 ${role.permissions.length} 项` : ''}
                    </span>
                  </TableCell>
                  <TableCell>
                    {role.memberCount} / {role.invitationCount}
                  </TableCell>
                  <TableCell>
                    <div className="team-row-actions">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!catalog.data}
                        onClick={() => setEditor({ role, action: 'view' })}
                      >
                        查看
                      </Button>
                      <ActionButton
                        action="edit"
                        actions={role.allowedActions}
                        enabled={write}
                        onClick={() => setEditor({ role, action: 'edit' })}
                      >
                        编辑
                      </ActionButton>
                      <ActionButton
                        action="delete"
                        actions={role.allowedActions}
                        enabled={write}
                        onClick={() => setEditor({ role, action: 'delete' })}
                      >
                        删除
                      </ActionButton>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <TeamPagination
          cursors={cursors}
          nextCursor={query.data?.nextCursor}
          loading={query.loading}
          onChange={setCursors}
        />
      </section>
      {editor && catalog.data && (
        <RoleEditor
          key={`${editor.role?.key ?? 'new'}:${editor.action}`}
          {...editor}
          catalog={catalog.data}
          client={client}
          onClose={() => setEditor(undefined)}
          onChanged={refresh}
          onPermissionsChanged={onPermissionsChanged}
        />
      )}
    </div>
  );
}
