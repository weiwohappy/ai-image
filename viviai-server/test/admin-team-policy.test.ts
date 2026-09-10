import { expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { AdminPermissionService } from '../src/modules/admin/permission.service.js';
import { teamWritesEnabled } from '../src/modules/admin/team/policy.js';
import { parseSuperAdminArgs } from '../src/scripts/admin-super-admin.js';
import { adminConfig } from './helpers/admin.js';
it('denies writes for nonloopback peers, origins and staging even if the host is loopback', () => {
  const config = {
    ...loadConfig(),
    nodeEnv: 'development' as const,
    host: '127.0.0.1',
    admin: adminConfig,
  };
  expect(teamWritesEnabled(config, '203.0.113.4')).toBe(false);
  expect(
    teamWritesEnabled({
      ...config,
      admin: { ...adminConfig, origins: ['https://admin.example.test'] },
    }),
  ).toBe(false);
  expect(teamWritesEnabled({ ...config, nodeEnv: 'staging' as 'development' })).toBe(false);
  expect(teamWritesEnabled(config, '::ffff:127.0.0.1')).toBe(true);
});
it('fails closed for absent, deleted, invalid-role and illegal-extra grants', () => {
  const resolver = new AdminPermissionService();
  const role = {
    key: 'custom_read',
    name: '查询',
    builtIn: false,
    permissions: ['dashboard.read'],
    deletedAt: null,
  };
  expect(resolver.resolve([], []).permissions).toEqual([]);
  expect(resolver.resolve([{ role: { ...role, deletedAt: new Date() } }], []).permissions).toEqual(
    [],
  );
  expect(
    resolver.resolve([{ role: { ...role, permissions: ['dashboard.read', 'admins.create'] } }], [])
      .permissions,
  ).toEqual([]);
  expect(
    resolver.resolve([{ role: { ...role, key: 'unknown_builtin', builtIn: true } }], [])
      .permissions,
  ).toEqual([]);
  expect(resolver.resolve([{ role }], ['future.secret']).permissions).toEqual([]);
  expect(resolver.resolve([{ role }], []).permissions).toEqual(['dashboard.read']);
});
it('defaults the first-super CLI to dry run and rejects missing or duplicate arguments', () => {
  const args = [
    '--email=operator@example.test',
    '--expected-version=3',
    '--reason=approved offline setup',
  ];
  expect(parseSuperAdminArgs(args)).toEqual({
    email: 'operator@example.test',
    expectedVersion: 3,
    reason: 'approved offline setup',
    apply: false,
  });
  expect(parseSuperAdminArgs([...args, '--apply']).apply).toBe(true);
  for (const bad of [
    [],
    [...args, '--email=another@example.test'],
    [...args, '--apply', '--apply'],
    [...args, '--unknown=true'],
  ])
    expect(() => parseSuperAdminArgs(bad)).toThrow();
});
