import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AdminClient } from '../src/http.ts';
import { readAuthLink } from '../src/auth-link.ts';
import { createTestDatabase } from '../../viviai-server/test/helpers/database.ts';
import { createTestStorage } from '../../viviai-server/test/helpers/storage.ts';
import {
  adminApp,
  adminOrigin,
  adminConfig,
  currentCode,
  fixtureAdmin,
} from '../../viviai-server/test/helpers/admin.ts';
import { hashPassword } from '../../viviai-server/src/modules/admin/crypto.ts';

// Production frontend transport/parser against real isolated HTTP/Prisma state.
// Cookie jars are test harness only; no secrets are printed or stored by the UI.
const nativeFetch = globalThis.fetch;
const jars = [];
let activeJar;
let db, storage, app;
function clientFor(cookie) {
  const jar = new Map();
  jars.push(jar);
  if (cookie) {
    const separator = cookie.indexOf('=');
    jar.set(cookie.slice(0, separator), cookie.slice(separator + 1));
  }
  const client = new AdminClient();
  return {
    get: (...args) => {
      activeJar = jar;
      return client.get(...args);
    },
    post: (...args) => {
      activeJar = jar;
      return client.post(...args);
    },
    command: (...args) => {
      activeJar = jar;
      return client.command(...args);
    },
  };
}
const reason = '隔离环境端到端验证团队管理';
const expectedStatus = (status) => (error) => error.status === status;
try {
  db = await createTestDatabase();
  storage = await createTestStorage();
  app = await adminApp(db, {
    nodeEnv: 'development',
    host: '127.0.0.1',
    admin: {
      ...adminConfig,
      localTestEmails: ['local-team@example.test'],
      localPasswordLogin: true,
    },
    localStorageRoot: storage.root,
    devMailboxRoot: `${storage.root}/mail`,
    queueNamespace: `team-http-smoke-${randomUUID()}`,
  });
  const address = app.getHttpServer().address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  globalThis.fetch = async (path, options = {}) => {
    assert(
      typeof path === 'string' && path.startsWith('/api/admin/'),
      'Only admin HTTP is allowed in this smoke',
    );
    const jar = activeJar;
    assert(jar);
    const headers = new Headers(options.headers);
    headers.set('Origin', adminOrigin);
    if (jar.size) headers.set('Cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
    const response = await nativeFetch(`${origin}${path}`, { ...options, headers });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0],
        separator = pair.indexOf('=');
      const key = pair.slice(0, separator),
        value = pair.slice(separator + 1);
      if (value) jar.set(key, value);
      else jar.delete(key);
    }
    return response;
  };
  const superFixture = await fixtureAdmin(db, ['super_admin']);
  const managerFixture = await fixtureAdmin(db, ['system_admin']);
  const ordinaryFixture = await fixtureAdmin(db, ['support']);
  const superAdmin = clientFor(superFixture.cookie),
    manager = clientFor(managerFixture.cookie),
    ordinary = clientFor(ordinaryFixture.cookie);
  const status = await superAdmin.get('/status');
  assert.equal(status.stage, 'B1');
  assert.equal(status.teamWritesEnabled, true);
  const catalog = await superAdmin.get('/team/permission-catalog');
  assert.equal(catalog.writeEnabled, true);
  assert(catalog.assignableRoles.some((r) => r.key === 'super_admin'));
  assert(!(await superAdmin.get('/me')).permissions.includes('sensitive.read'));

  const roleKey = 'custom_smoke_analyst';
  await superAdmin.command(
    'POST',
    '/team/roles',
    {
      key: roleKey,
      name: '隔离模型分析员',
      description: '仅测试',
      permissions: ['dashboard.read', 'models.read', 'dashboard.models.read'],
      reason,
    },
    randomUUID(),
  );
  const savedRole = await manager.get(`/team/roles/${roleKey}`);
  assert.equal(savedRole.name, '隔离模型分析员');
  const targetPath = `/team/members/${ordinaryFixture.account.id}`;
  let member = await manager.get(targetPath);
  await manager.command(
    'PATCH',
    targetPath,
    { displayName: '隔离测试成员', expectedVersion: member.version, reason },
    randomUUID(),
  );
  member = await manager.get(targetPath);
  assert.equal(member.displayName, '隔离测试成员');
  await manager.command(
    'PUT',
    `${targetPath}/roles`,
    { roles: [roleKey], expectedVersion: member.version, reason },
    randomUUID(),
  );
  await assert.rejects(ordinary.get('/me'), expectedStatus(401));
  const roleInUse = await superAdmin.get(`/team/roles/${roleKey}`);
  assert.equal(roleInUse.memberCount, 1);
  await assert.rejects(
    superAdmin.command(
      'DELETE',
      `/team/roles/${roleKey}`,
      { expectedVersion: roleInUse.version, reason },
      randomUUID(),
    ),
    expectedStatus(409),
  );
  member = await manager.get(targetPath);
  const disableBody = { expectedVersion: member.version, reason },
    disableKey = randomUUID();
  const disabled = await manager.command('POST', `${targetPath}/disable`, disableBody, disableKey);
  assert.equal(
    (await manager.command('POST', `${targetPath}/disable`, disableBody, disableKey)).version,
    disabled.version,
  );
  member = await manager.get(targetPath);
  assert.equal(member.status, 'disabled');
  await manager.command(
    'POST',
    `${targetPath}/enable`,
    { expectedVersion: member.version, reason },
    randomUUID(),
  );
  await assert.rejects(ordinary.get('/me'), expectedStatus(401));
  member = await manager.get(targetPath);
  const resetKey = randomUUID(),
    resetBody = { expectedVersion: member.version, reason };
  const resetResult = await manager.command(
    'POST',
    `${targetPath}/password-resets`,
    resetBody,
    resetKey,
  );
  const replay = await manager.command(
    'POST',
    `${targetPath}/password-resets`,
    resetBody,
    resetKey,
  );
  assert.equal(replay.linkUnavailable, true);
  assert(!replay.link);
  const resetLink = readAuthLink(new URL(resetResult.link).hash);
  assert(resetLink?.kind === 'reset');
  const recovering = clientFor();
  const resetData = {
    token: resetLink.token,
    email: resetLink.email,
    password: 'new-test-only-password-123',
  };
  assert.equal(
    (await recovering.post('/auth/password-resets/accept', resetData, undefined, false)).success,
    true,
  );
  await assert.rejects(recovering.get('/me'), expectedStatus(401));
  await assert.rejects(
    recovering.post('/auth/password-resets/accept', resetData, undefined, false),
    expectedStatus(400),
  );
  assert.equal(
    (
      await recovering.post(
        '/auth/login',
        { email: resetLink.email, password: resetData.password },
        undefined,
        false,
      )
    ).next,
    'mfa',
  );
  const loggedIn = await recovering.post(
    '/auth/mfa/verify',
    { method: 'totp', code: currentCode() },
    undefined,
    false,
  );
  assert(loggedIn.account.roles.includes(roleKey));
  assert(loggedIn.account.permissions.includes('dashboard.models.read'));
  member = await manager.get(targetPath);
  await manager.command(
    'PUT',
    `${targetPath}/roles`,
    { roles: ['support'], expectedVersion: member.version, reason },
    randomUUID(),
  );
  await assert.rejects(recovering.get('/me'), expectedStatus(401));
  const unusedRole = await superAdmin.get(`/team/roles/${roleKey}`);
  await superAdmin.command(
    'DELETE',
    `/team/roles/${roleKey}`,
    { expectedVersion: unusedRole.version, reason },
    randomUUID(),
  );
  await assert.rejects(superAdmin.get(`/team/roles/${roleKey}`), expectedStatus(404));

  const inviteBody = {
    email: 'invited-team@example.test',
    displayName: '受邀测试成员',
    roles: ['support'],
    reason,
  };
  const invited = await manager.command('POST', '/team/invitations', inviteBody, randomUUID());
  const original = readAuthLink(new URL(invited.link).hash);
  assert(original?.kind === 'invite');
  const rotated = await manager.command(
    'POST',
    `/team/invitations/${invited.resourceId}/rotate`,
    { expectedVersion: invited.version, reason },
    randomUUID(),
  );
  const replacement = readAuthLink(new URL(rotated.link).hash);
  assert(replacement?.kind === 'invite');
  const invitee = clientFor();
  const accept = (link) =>
    invitee.post(
      '/auth/invitations/accept',
      {
        token: link.token,
        email: link.email,
        displayName: link.displayName,
        password: 'new-invite-password-123',
      },
      undefined,
      false,
    );
  await assert.rejects(accept(original), expectedStatus(401));
  const enrollment = await accept(replacement);
  assert.equal(enrollment.next, 'enroll');
  await assert.rejects(invitee.get('/me'), expectedStatus(401));
  const activated = await invitee.post(
    '/auth/mfa/verify',
    { method: 'totp', code: currentCode(enrollment.secret) },
    undefined,
    false,
  );
  assert.equal(activated.account.email, inviteBody.email);
  assert.equal(activated.recoveryCodes.length, 8);
  const inviteHistory = await manager.get(
    `/team/invitations?q=${encodeURIComponent(inviteBody.email)}&limit=30`,
  );
  assert.equal(inviteHistory.items[0].status, 'consumed');
  assert(inviteHistory.items[0].allowedActions.every((a) => !a.allowed));

  const localFixture = await fixtureAdmin(db, ['system_admin']);
  await db.database.client.adminAccount.update({
    where: { id: localFixture.account.id },
    data: {
      email: 'local-team@example.test',
      status: 'pending',
      lastTotpCounter: null,
      passwordHash: await hashPassword('123456', 6),
    },
  });
  const local = clientFor();
  const localLogin = await local.post(
    '/auth/login',
    { email: 'local-team@example.test', password: '123456' },
    undefined,
    false,
  );
  assert.equal(localLogin.account.email, 'local-team@example.test');
  for (const client of [superAdmin, manager, invitee, local]) {
    await client.post('/auth/logout', {}, undefined, false);
    await assert.rejects(client.get('/me'), expectedStatus(401));
  }
  console.info(
    'Team HTTP smoke passed: real client, role CRUD, member edit/roles/disable/enable, single-use reset, invite rotation/MFA activation, local login, session revocation. Isolated fixtures only.',
  );
} finally {
  globalThis.fetch = nativeFetch;
  jars.forEach((jar) => jar.clear());
  await app?.close();
  await db?.cleanup();
  await storage?.cleanup();
}
