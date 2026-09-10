import { useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
import type {
  TeamAction,
  TeamList,
  TeamMember,
  TeamInvitation,
  PermissionCatalog,
} from './contracts';
import {
  ActionButton,
  canAct,
  reasonText,
  RoleTags,
  TeamPagination,
  TeamSelect,
} from './presentation';
import { MemberEditor } from './MemberEditor';
import { InvitationEditor } from './InvitationEditor';
const statuses: Record<string, string> = {
  active: '已激活',
  pending: '待激活',
  disabled: '已禁用',
  expired: '已过期',
  revoked: '已撤销',
  consumed: '已使用',
};
type Editor =
  | { kind: 'member'; record: TeamMember; action: TeamAction }
  | { kind: 'invitation'; record?: TeamInvitation; action: TeamAction };
export function TeamPage({
  actor,
  client,
  onPermissionsChanged,
}: {
  actor: AdminActor;
  client: AdminClient;
  onPermissionsChanged: () => Promise<void>;
}) {
  const [tab, setTab] = useState('members');
  const [draft, setDraft] = useState({ q: '', status: '', role: '' });
  const [filter, setFilter] = useState('');
  const [cursors, setCursors] = useState(['']);
  const [revision, setRevision] = useState(0);
  const [editor, setEditor] = useState<Editor>();
  const catalog = useAdminQuery<PermissionCatalog>(client, '/team/permission-catalog');
  const query = useAdminQuery<TeamList<TeamMember | TeamInvitation>>(
    client,
    `/team/${tab}?limit=30${filter}${cursors.at(-1) ? `&cursor=${encodeURIComponent(cursors.at(-1)!)}` : ''}`,
    revision,
  );
  const write = catalog.data?.writeEnabled === true;
  const refreshed = () => setRevision((n) => n + 1);
  const common = {
    client,
    catalog: catalog.data!,
    onClose: () => setEditor(undefined),
    onChanged: refreshed,
    onPermissionsChanged,
  };
  const rows = query.data?.items ?? [];
  return (
    <div className="team-page">
      <div className="team-page-toolbar">
        <Tabs
          value={tab}
          onValueChange={(value) => {
            setTab(String(value));
            setDraft({ q: '', status: '', role: '' });
            setFilter('');
            setCursors(['']);
          }}
        >
          <TabsList variant="line" aria-label="团队记录">
            <TabsTrigger value="members">成员</TabsTrigger>
            <TabsTrigger value="invitations">待激活邀请</TabsTrigger>
          </TabsList>
        </Tabs>
        <Button
          disabled={
            !write ||
            !actor.permissions.includes('admins.create') ||
            !canAct(query.data?.allowedActions ?? [], 'create')
          }
          onClick={() => setEditor({ kind: 'invitation', action: 'create' })}
        >
          <Plus size={16} />
          新增成员
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
          onSubmit={(e) => {
            e.preventDefault();
            const params = new URLSearchParams();
            if (draft.q.trim()) params.set('q', draft.q.trim().toLowerCase());
            if (draft.status) params.set('status', draft.status);
            if (draft.role && tab === 'members') params.set('role', draft.role);
            setFilter(params.size ? `&${params}` : '');
            setCursors(['']);
            refreshed();
          }}
        >
          <Input
            aria-label="精确邮箱查询"
            className="team-search"
            placeholder="精确输入成员邮箱"
            value={draft.q}
            maxLength={254}
            onChange={(e) => setDraft({ ...draft, q: e.target.value })}
          />
          <TeamSelect
            label="全部状态"
            value={draft.status}
            options={(tab === 'members'
              ? ['active', 'pending', 'disabled']
              : ['pending', 'expired', 'revoked', 'consumed']
            ).map((key) => [key, statuses[key]])}
            onChange={(status) => setDraft({ ...draft, status })}
          />
          {tab === 'members' && (
            <TeamSelect
              label="全部角色"
              value={draft.role}
              options={(catalog.data?.assignableRoles ?? []).map((r) => [r.key, r.name])}
              onChange={(role) => setDraft({ ...draft, role })}
            />
          )}
          <Button type="submit" disabled={query.loading}>
            查询
          </Button>
          <Button type="button" variant="outline" onClick={refreshed} disabled={query.loading}>
            <RefreshCw size={15} />
            刷新
          </Button>
        </form>
        {query.loading ? (
          <p className="loading-state" role="status">
            正在读取团队记录…
          </p>
        ) : query.error ? (
          <p className="error-banner" role="alert">
            {query.error}
          </p>
        ) : !rows.length ? (
          <p className="empty-state">没有符合条件的{tab === 'members' ? '成员' : '邀请'}记录</p>
        ) : (
          <Table className="team-table">
            <TableHeader>
              <TableRow>
                <TableHead>成员</TableHead>
                <TableHead>角色</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>{tab === 'members' ? '加入时间' : '到期时间'}</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const actions: Array<[TeamAction, string]> =
                  tab === 'members'
                    ? [
                        ['edit', '编辑'],
                        ['assignRoles', '分配角色'],
                        [
                          row.status === 'disabled' ? 'enable' : 'disable',
                          row.status === 'disabled' ? '启用' : '禁用',
                        ],
                        ['resetPassword', '重置密码'],
                      ]
                    : [
                        ['edit', '编辑'],
                        ['rotate', '重新生成'],
                        ['revoke', '撤销'],
                      ];
                const blocked = [
                  ...new Set(
                    row.allowedActions
                      .filter((a) => !a.allowed)
                      .map((a) => reasonText(a.reasonCode)),
                  ),
                ];
                return (
                  <TableRow key={row.id}>
                    <TableCell>
                      <strong>{row.displayName}</strong>
                      <span className="team-email">{row.email}</span>
                    </TableCell>
                    <TableCell>
                      <RoleTags roles={row.roles} />
                    </TableCell>
                    <TableCell>
                      <span className={`status-pill status-${row.status}`}>
                        {statuses[row.status]}
                      </span>
                    </TableCell>
                    <TableCell>
                      {new Date('expiresAt' in row ? row.expiresAt : row.createdAt).toLocaleString(
                        'zh-CN',
                        { timeZone: 'Asia/Shanghai', hour12: false },
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="team-row-actions">
                        {actions.map(([action, label]) => (
                          <ActionButton
                            key={action}
                            action={action}
                            actions={row.allowedActions}
                            enabled={write}
                            onClick={() =>
                              setEditor(
                                tab === 'members'
                                  ? { kind: 'member', record: row as TeamMember, action }
                                  : { kind: 'invitation', record: row as TeamInvitation, action },
                              )
                            }
                          >
                            {label}
                          </ActionButton>
                        ))}
                      </div>
                      {blocked.map((text) => (
                        <small className="team-action-reason" key={text}>
                          {text}
                        </small>
                      ))}
                    </TableCell>
                  </TableRow>
                );
              })}
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
      {query.data && (
        <p className="caption team-data-time">
          数据截至{' '}
          {new Date(query.data.asOf).toLocaleString('zh-CN', {
            timeZone: 'Asia/Shanghai',
            hour12: false,
          })}
          （上海时间）
        </p>
      )}
      {editor &&
        catalog.data &&
        (editor.kind === 'member' ? (
          <MemberEditor
            key={`${editor.record.id}:${editor.action}`}
            member={editor.record}
            action={editor.action}
            {...common}
          />
        ) : (
          <InvitationEditor
            key={`${editor.record?.id ?? 'new'}:${editor.action}`}
            invitation={editor.record}
            action={editor.action}
            {...common}
          />
        ))}
    </div>
  );
}
