import { vi } from 'vitest';
import { actor, json } from '../test/fixtures';
import type { AllowedAction, TeamAction } from './contracts';
export const teamActor = {
  ...actor,
  roles: ['super_admin'],
  permissions: [
    'dashboard.read',
    'admins.read',
    'roles.read',
    'admins.create',
    'admins.update',
    'admins.roles.assign',
    'admins.status.update',
    'admins.password.reset',
    'roles.create',
    'roles.update',
    'roles.delete',
  ],
};
export const roleOptions = [
  { key: 'support', name: '客服', builtIn: true, permissions: ['dashboard.read', 'users.read'] },
  {
    key: 'model_operator',
    name: '模型运营',
    builtIn: true,
    permissions: ['dashboard.read', 'models.read'],
  },
];
export const permissionEntries = [
  {
    key: 'dashboard.read',
    name: '工作概览',
    module: '工作台',
    dependencies: [],
    customRoleAllowed: true,
  },
  {
    key: 'users.read',
    name: '用户查询',
    module: '业务查询',
    dependencies: [],
    customRoleAllowed: true,
  },
  {
    key: 'models.read',
    name: '模型查询',
    module: '模型运行',
    dependencies: [],
    customRoleAllowed: true,
  },
  {
    key: 'dashboard.models.read',
    name: '模型概览',
    module: '工作台',
    dependencies: ['dashboard.read', 'models.read'],
    customRoleAllowed: true,
  },
  {
    key: 'admins.update',
    name: '成员编辑',
    module: '团队管理',
    dependencies: ['admins.read'],
    customRoleAllowed: false,
  },
];
const actions = (names: TeamAction[]): AllowedAction[] =>
  names.map((action) => ({ action, allowed: true, reasonCode: null }));
export function setupTeamApi(
  options: {
    failOnce?: number;
    loseOnce?: boolean;
    protectedMember?: boolean;
    writeEnabled?: boolean;
  } = {},
) {
  const member = {
    id: 'member-1',
    email: 'lin@example.test',
    displayName: '客服小林',
    roles: [roleOptions[0]],
    status: 'active',
    activated: true,
    version: 1,
    createdAt: '2026-09-10T00:00:00Z',
    allowedActions: actions(['edit', 'assignRoles', 'disable', 'resetPassword']),
  };
  if (options.protectedMember)
    member.allowedActions = [
      { action: 'disable', allowed: false, reasonCode: 'ADMIN_TEAM_SELF_PROTECTED' },
    ];
  let invitations: Record<string, unknown>[] = [];
  const roles: Record<string, unknown>[] = roleOptions.map((role) => ({
    ...role,
    description: '',
    version: 1,
    memberCount: 1,
    invitationCount: 0,
    allowedActions: [],
  }));
  const commands: { method: string; path: string; key: string; body: Record<string, unknown> }[] =
    [];
  const requests: string[] = [];
  const pages = (items: unknown[]) => ({
    items,
    nextCursor: null,
    asOf: '2026-09-10T00:00:00Z',
    allowedActions: actions(['create']),
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (raw: string, init?: RequestInit) => {
      const url = new URL(String(raw), 'http://localhost:3010');
      const path = url.pathname.replace('/api/admin', '');
      const method = init?.method ?? 'GET';
      requests.push(String(raw));
      if (method === 'GET') {
        if (path === '/team/permission-catalog')
          return json({
            permissions: permissionEntries,
            assignableRoles: roleOptions,
            writeEnabled: options.writeEnabled !== false,
          });
        if (path === '/team/members') return json(pages([member]));
        if (path === '/team/members/member-1') return json(member);
        if (path === '/team/invitations') return json(pages(invitations));
        if (path === '/team/roles') return json(pages(roles));
        if (path.startsWith('/team/roles/'))
          return json(roles.find((r) => r.key === path.split('/').pop()));
        return json(null, 404);
      }
      const body = JSON.parse(String(init?.body));
      const key = new Headers(init?.headers).get('Idempotency-Key') ?? '';
      if (!key) return json(null, 400);
      commands.push({ method, path, key, body });
      if (commands.length === 1 && options.loseOnce) throw new TypeError('Network disconnected');
      if (commands.length === 1 && options.failOnce) {
        member.version = 2;
        return json(null, options.failOnce);
      }
      if (path === '/team/invitations' && method === 'POST') {
        if (
          body.email !== 'colleague@example.test' ||
          body.displayName !== '新同事' ||
          !Array.isArray(body.roles) ||
          !body.roles.length
        )
          return json(null, 400);
        invitations = [
          {
            id: 'invite-1',
            ...body,
            roles: [roleOptions[0]],
            version: 1,
            status: 'pending',
            createdAt: '2026-09-10T00:00:00Z',
            expiresAt: '2026-09-11T00:00:00Z',
            allowedActions: actions(['edit', 'rotate', 'revoke']),
          },
        ];
        return json(
          {
            resourceId: 'invite-1',
            version: 1,
            link: 'http://localhost:3010/#/accept?token=' + 'a'.repeat(43),
            expiresAt: '2026-09-11T00:00:00Z',
          },
          201,
        );
      }
      if (path.startsWith('/team/members/member-1')) {
        if (body.expectedVersion !== member.version) return json(null, 409);
        if (method === 'PATCH') member.displayName = String(body.displayName);
        if (path.endsWith('/roles'))
          member.roles = roleOptions.filter((r) => (body.roles as string[]).includes(r.key));
        if (path.endsWith('/disable')) member.status = 'disabled';
        member.version++;
        return json(
          { resourceId: member.id, version: member.version },
          method === 'POST' ? 201 : 200,
        );
      }
      if (path === '/team/roles' && method === 'POST') {
        roles.push({
          ...body,
          builtIn: false,
          version: 1,
          memberCount: 0,
          invitationCount: 0,
          allowedActions: actions(['edit', 'delete']),
        });
        return json({ resourceId: body.key, version: 1 }, 201);
      }
      return json(null, 404);
    }),
  );
  return { commands, requests, member, roles };
}
