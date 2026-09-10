# Admin Team and Permissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved B1 team-management console with durable member/invitation/role writes, a real super administrator, and local end-to-end verification.

**Architecture:** Extend the existing NestJS/PostgreSQL admin module; relational role bindings feed one permission resolver used by authentication and queries. The existing Vinext admin frontend uses typed management endpoints and keeps business pages read-only. No external identity provider, mail delivery, deployment or business mutation is added.

**Tech Stack:** Existing Node 22.22.2, TypeScript, NestJS, Prisma/PostgreSQL, Vitest/Supertest; React/Vinext and installed Shadcn primitives.

**Spec:** `docs/superpowers/specs/2026-09-10-admin-team-permissions-design.md` (approved 2026-09-10).

**Execution status:** B1 completed and locally verified2026-09-10. Backend265/265, frontend90/90, both actual-client HTTP smokes and static/build checks pass. Task/full-increment reviews and the final invitation-recovery fix review pass. Private backup verified; local migration and exact first-account promotion applied; original passwords/MFA and second account preserved. Full acceptance record: spec§13. Existing worktree/preview retained, no merge/push/deploy.

## Global Constraints

- 本批不实现上述业务写操作，不开放生产环境，不调用模型、支付或邮件服务。审计记录永远不可编辑或删除。
- 两个账号的已有密码和本机免 MFA 例外保持不变；不把短密码或免 MFA 自动扩展给所有新成员。
- `super_admin` 使用显式版本化权限集合，不采用 `*`，不自动获得未来尚未实现的权限。
- 管理角色不能在线编辑、重命名或删除。
- 账号仅启用/禁用，不做物理删除；邮箱作为登录身份在本批不可编辑，避免静默替换身份或改变本地例外适用范围。
- 成员/角色表单和写接口不能修改 `extraPermissions`。
- Scope all changes to `viviai-server`, `viviai-admin`, this plan/spec, and this plan's ignored progress workspace. Preserve existing unrelated `viviai-web` changes. Never stage all files.
- Existing isolated checkout: `.worktrees/viviai-frontend`, branch `codex/viviai-frontend`. Preserve existing dependencies and local preview. No browser QA, push, merge, publish or paid API calls.
- Backend tests use `test/helpers/database.ts` random owned schemas, never truncate the public schema or modify real staff as fixtures. Public migration/account promotion occur only in Task 3.
- Node command prefix: `PATH=/Users/weiys/.nvm/versions/node/v22.22.2/bin:$PATH`; backend tests additionally use `NODE_ENV=test DATABASE_URL=postgresql://viviai@127.0.0.1:55432/viviai_dev REDIS_URL=redis://127.0.0.1:56379`. Network tests may require sandbox escalation.
- The Site-owning root agent alone edits `viviai-admin`. A backend implementer may edit only `viviai-server`; reviewers are read-only and no worker spawns children.

---

## File and interface map

Backend responsibility units, all under `viviai-server/src/modules/admin/`:

- `team/contracts.ts`: public DTOs below; no Prisma models in HTTP responses.
- `permission-catalog.ts`: immutable built-in templates, Chinese labels and dependency validation.
- `permission.service.ts`: database role resolution, protected-target checks, assignable role checks.
- `team/policy.ts`: local-write gate, action availability, input constraints.
- `team/transaction.ts`: canonical locks, command receipts, audit and invalidation helpers.
- `team/members.service.ts`: member listing/detail/profile/roles/status.
- `team/invitations.service.ts`: invitation create/edit/rotate/revoke/list.
- `team/roles.service.ts`: catalog and custom role CRUD.
- `team/password-reset.service.ts`: issue and consume one-use reset links.
- `team/team.controller.ts`, `team/password-reset.controller.ts`: strict parsing/route mapping.
- `team/bootstrap-super-admin.ts`, `src/scripts/admin-super-admin.ts`: audited dry-run/apply first-super-admin command, no email constants.

Modify existing `permissions.ts`, `auth.service.ts`, `auth.controller.ts`, `bootstrap.ts`, `audit.service.ts`, `query.service.ts`, `sensitive.service.ts`, `admin.module.ts` and schema/test fixtures wherever the relational binding/disabledAt integration requires it. Keep existing GET DTO shapes compatible.

Frontend responsibility units under `viviai-admin/src/team/`:

- `contracts.ts`: mirror backend DTOs without importing its runtime.
- `TeamPage.tsx`: members/invitations tabs, search/filter/pagination, list actions.
- `MemberEditor.tsx`, `InvitationEditor.tsx`: typed edit/create/role/status forms.
- `RolesPage.tsx`, `RoleEditor.tsx`: role list, details and dependency-aware permissions.
- `ActionForm.tsx`: shared reason/confirmation/error/unknown-result controls and in-memory idempotency lifecycle.
- `LinkResult.tsx`: one-time copy/manual-select link feedback.
- `PasswordResetScreen.tsx`, `auth-link.ts`: fragment parsing/clearing and anonymous reset flow.

Use existing `sheet`, `tabs`, `button`, `input`, `textarea`, `table` primitives at their existing paths. No decorative imagery. Retain blue/white palette and 14px minimum regular labels; keep the main table and its action visible without a hero.

### Shared HTTP DTOs (Task 1 produces; Tasks 2–3 consume)

```ts
export type TeamAction = 'create' | 'edit' | 'assignRoles' | 'enable' | 'disable' |
  'resetPassword' | 'rotate' | 'revoke' | 'delete';
export interface AllowedAction { action: TeamAction; allowed: boolean; reasonCode: string | null }
export interface RoleOption { key: string; name: string; builtIn: boolean; permissions: string[] }
export interface TeamMember {
  id: string; email: string; displayName: string;
  status: 'pending' | 'active' | 'disabled'; activated: boolean;
  roles: RoleOption[]; version: number; createdAt: string; allowedActions: AllowedAction[];
}
export interface TeamInvitation {
  id: string; email: string; displayName: string; roles: RoleOption[];
  status: 'pending' | 'expired' | 'revoked' | 'consumed';
  version: number; expiresAt: string; createdAt: string; allowedActions: AllowedAction[];
}
export interface TeamRole extends RoleOption {
  description: string; version: number; memberCount: number; invitationCount: number;
  allowedActions: AllowedAction[];
}
export interface TeamList<T> {
  items: T[]; nextCursor: string | null; asOf: string; allowedActions: AllowedAction[];
}
export interface PermissionEntry {
  key: string; name: string; module: string; dependencies: string[]; customRoleAllowed: boolean;
}
export interface PermissionCatalog {
  permissions: PermissionEntry[]; assignableRoles: RoleOption[]; writeEnabled: boolean;
}
export interface TeamMutationResult {
  resourceId: string; version: number;
  link?: string; linkUnavailable?: boolean; expiresAt?: string;
}
export interface TeamCommandMeta { expectedVersion?: number; reason: string }
```

`/status`: retain existing fields; `stage: 'B1'`, add `teamWritesEnabled: boolean`. `AdminActor` shape stays compatible. All team responses use existing `{data,message,requestId}` envelope. Failed team requests add a stable `code`; frontend maps known codes and never displays arbitrary raw provider/proxy text.

Mutation bodies: create invitation `{email,displayName,roles:string[],reason}`; edit invitation `{displayName?,roles?,expectedVersion,reason}`; member edit `{displayName,expectedVersion,reason}`; assign roles `{roles,expectedVersion,reason}`; enable/disable/reset/rotate/revoke/delete `{expectedVersion,reason}`; role create `{key,name,description,permissions:string[],reason}`; role edit `{name,description,permissions:string[],expectedVersion,reason}`. Admin writes carry UUID `Idempotency-Key`; anonymous reset accepts `{token,email,password}`. Invitation links use `#/accept?token=...&email=...&displayName=...`; reset links `#/reset-password?token=...&email=...`. Frontend consumes and immediately removes fragments' secrets.

## Task 1: Durable backend team commands and unified authorization

**Files:** all backend units listed above; `prisma/schema.prisma`; new migration `prisma/migrations/20260910030000_admin_team_management/migration.sql`; `test/helpers/admin.ts`; `test/helpers/admin-team.ts`; `test/integration/admin-team.test.ts`; `test/integration/admin-team-races.test.ts`; `test/integration/admin-team-migration.test.ts`; existing admin test files; `README.md`; `package.json` only to add CLI script if needed.

**Interfaces:** consumes existing `DatabaseService`, `DbTransaction`, `AdminContext`, `AdminAuditService`, `AdminAuthService.reauthorize`, crypto helpers and random-schema fixture. Produces all HTTP DTOs above and all spec §7 endpoints; public reset success is `{success:true}`. Exports `bootstrapSuperAdministrator(db: DatabaseService, config: AppConfig, input: {email:string; expectedVersion:number; reason:string; apply:boolean}): Promise<{accountId:string; roles:string[]; version:number; applied:boolean}>`.

- [x] **Step 1: Write failing HTTP authorization/creation tests using real app and database.** Add `teamFixture()` in test helpers returning `{db, app, superAdmin, manager, ordinary, post, close}`. It uses `createTestDatabase()`, `adminApp(db,{nodeEnv:'development',host:'127.0.0.1'})`, `fixtureAdmin` for super_admin/system_admin/support and an actor-specific HTTP call function. First assertion is successful creation, not source-text existence:

```ts
const f = await teamFixture();
try {
  const body = {email:'invitee@example.test',displayName:'客服同事',roles:['support'],reason:'新增客服岗位成员'};
  const key = randomUUID();
  const first = await f.post(f.superAdmin.cookie, '/team/invitations', body, key);
  expect(first.status).toBe(201);
  expect(first.body.data.link).toContain('#/accept?token=');
  const again = await f.post(f.superAdmin.cookie, '/team/invitations', body, key);
  expect(again.body.data.resourceId).toBe(first.body.data.resourceId);
  expect(again.body.data.link).toBeUndefined();
  expect(again.body.data.linkUnavailable).toBe(true);
  expect(await f.db.database.client.adminInvitation.count({where:{email:body.email}})).toBe(1);
} finally { await f.close(); }
```

- [x] **Step 2: Run focused tests and record RED.** `npm test -- test/integration/admin-team.test.ts`; expect missing team route / absent super role behavior, not unrelated fixture syntax errors. Add incremental failure tests before each functional slice below.

- [x] **Step 3: Create migration and DB resolver, update existing auth consumers/fixtures.** Role tables, bindings, disabledAt/version, reset/receipt and audit metadata follow spec §6 exactly. Migration uses one transaction, validates every old role key before backfill, seeds built-ins, backfills account/invitation role bindings and removes old array columns. Validate legacy state using `lastTotpCounter`/active status evidence; no guessed activated state. The failure test migrates an isolated database only through the previous migration, inserts old records, then applies the new migration and reads resulting roles/status. An unknown old role must roll back without losing original arrays.

Resolver returns empty/denied for no roles, deleted/unknown bindings or illegal extras; relational reads are authoritative. `permissions.ts` may retain a pure built-in template helper for bootstrap input validation but auth/query never read legacy arrays or independently resolve dynamic roles. Replace role-name data checks with spec §3.3 capability/underlying permission intersections.

```ts
const allowed = resolved.permissions.includes('dashboard.finance.read') &&
  resolved.permissions.includes('orders.read') && resolved.permissions.includes('credits.read');
expect(allowed).toBe(false); // Fixture contains costs.read only, not financial access.
```

- [x] **Step 4: Implement command boundary with tests for each gate and replay.** Shared command function reauthorizes current session inside a transaction, checks local gate and permission, acquires canonical global/email/invitation/ascending-account locks, checks idempotency, expectedVersion and target, performs mutation, audit and nonsecret receipt atomically. Explicit failure tests: test/staging/nonloopback writes 503, wrong Origin 403, unknown fields 400, ordinary member 403, system_admin editing owner 403, same key/different payload 409, stale version 409, self-disable 409. A recognized rejection audit persists separately without raw bodies.

```ts
async function withCurrentTeamSession<T>(context: AdminContext,
  work: (tx: DbTransaction, current: AdminContext) => Promise<T>): Promise<T> {
  return db.transaction(async tx => {
    await lockTeam(tx);
    const current = await auth.reauthorize(tx, context.sessionId, context.actor.id, context.requestIp ?? 'unknown');
    return work(tx, current);
  });
}
```

Here `lockTeam(tx: DbTransaction): Promise<void>` is the canonical shared advisory lock exported from `team/transaction.ts`; integrate ordering into existing login/accept/verify/resolve/bootstrap/revoke/sensitive flows to prevent reverse acquisition. No network work inside transactions. Audit metadata accepts only whitelisted keys. DisabledAt is checked in every credential/challenge/session acceptance path.

- [x] **Step 5: Implement member/invitation/role commands and DTO queries.** Enforce spec §3–5 including protected extras, safe built-ins, assignment delegation, own-name exception, last usable super-admin check, no super-admin invites, custom role dependency checks, consumed invitation immutability, role rotation and deletion reference constraints. Invitations are editable after expiry/revocation until consumed, but role edits revoke links; regenerate revalidates role references. Use 30/default100/max stable keyset pagination and exact email filtering. Grant mutation bumps target version/authVersion and invalidates sessions, challenges and sensitive grants. Custom permission edits invalidate affected accounts and version so stale concurrent member changes cannot overwrite state.

```ts
const results = await Promise.all([
  f.post(first.cookie, `/team/members/${second.account.id}/disable`, {expectedVersion:1,reason:'并发禁用另一位管理员'}, randomUUID()),
  f.post(second.cookie, `/team/members/${first.account.id}/disable`, {expectedVersion:1,reason:'并发禁用另一位管理员'}, randomUUID()),
]);
expect(results.filter(r => r.status === 201)).toHaveLength(1);
expect(await countUsableSupers(f.db)).toBe(1);
```

`countUsableSupers` is test-only: count active/non-disabled accounts with super_admin binding; use explicit local allowlisted pending fixture separately. Add direct tests for role edit versus member assignment, invitation rotation/role edit versus acceptance, and stale-session write after authorization removal.

- [x] **Step 6: Implement invitation links and password reset without SMTP.** Use trusted configured admin Origin; 24h invite and 30m reset tokens hashed at rest. Generate link only once, store sanitized receipt; subsequent replay returns linkUnavailable. Reset issuance revokes sessions/challenges/older reset links, rejects disabled/self/protected targets appropriately. Accept validates matching normalized email and current password policy, atomically consumes token and hashes password, bumps authVersion/version, revokes all sessions/grants, returns no session. MFA secret/counter/recovery codes untouched. Anonymous endpoint has durable credential/IP rate limiting and Origin validation.

```ts
const issued = await f.post(f.superAdmin.cookie, `/team/members/${f.ordinary.account.id}/password-resets`,
  {expectedVersion:1,reason:'员工申请重置登录密码'}, randomUUID());
const fragment = new URL(issued.body.data.link).hash.split('?')[1];
const token = new URLSearchParams(fragment).get('token');
const reset = {token,email:f.ordinary.account.email,password:'new-team-password-123'};
expect((await request(f.app.getHttpServer()).post('/api/admin/auth/password-resets/accept')
  .set('Origin',adminOrigin).send(reset)).status).toBe(201);
expect((await request(f.app.getHttpServer()).post('/api/admin/auth/password-resets/accept')
  .set('Origin',adminOrigin).send(reset)).status).toBe(400);
```

- [x] **Step 7: Implement dry-run/apply first-super CLI.** No staff constants; require exact normalized email, expectedVersion, reason, valid local config and usable target, and no current super binding. Preserve roles/password/MFA/extras; apply only adds binding, bumps versions, invalidates sessions and audits offline actor as null. Dry-run never mutates, second apply does not silently repeat. Unit/integration CLI service tests use fixtures only. Register `admin:super-admin` script and document arguments and real-mail-disabled invitation behavior.

- [x] **Step 8: Run all backend checks and self-review; commit only backend files.** Focused tests first; then `npm test`, `npm run typecheck`, `npm run format:check`, `npm run build`. Inspect migration, sensitive response snapshots, role data scopes and lock ordering. Write RED/GREEN and exact commands/results to task report. Do not migrate public DB or restart user's server here.

## Task 2: Working member and role management frontend

**Files:** frontend units from the map; modify `src/http.ts`, `src/contracts.ts`, `src/navigation.ts`, `src/ConsoleShell.tsx`, `src/AdminApp.tsx`, `src/AuthScreen.tsx`, `app/globals.css`; tests `src/team/TeamPage.test.tsx`, `src/team/RolesPage.test.tsx`, `src/team/PasswordResetScreen.test.tsx`, `src/http.test.ts`, existing auth/app/query tests as contracts require.

**Interfaces:** consumes Task 1 DTO/endpoints above. `AdminClient.command<T>(method:'POST'|'PATCH'|'PUT'|'DELETE',path:string,body:unknown,idempotencyKey:string,signal?:AbortSignal):Promise<T>`; preserve existing `post` authentication semantics. Export `TeamPage({actor,client,onPermissionsChanged})`, `RolesPage({actor,client,onPermissionsChanged})`, and `PasswordResetScreen({client,link,onDone,localTestPasswords,environment})`. `onPermissionsChanged:()=>Promise<void>` refreshes `/me` and invalidates prior cached data; unauthorized still uses existing callback.

- [x] **Step 1: Write RED client and component tests.** Real AdminClient with fetch-level controlled envelopes; installed React components, not mocked sidebar/forms. Verify body/header/method, disabled buttons/reason, Chinese validation, data reload after persisted success, retained 409 input, and same-key network retry.

```tsx
render(<TeamPage actor={actor} client={client} onPermissionsChanged={async()=>{}} />);
await user.click(await screen.findByRole('button',{name:'新增成员'}));
await user.type(screen.getByLabelText('工作邮箱'),'colleague@example.test');
await user.type(screen.getByLabelText('显示名称'),'新同事');
await user.click(screen.getByLabelText('客服'));
await user.type(screen.getByLabelText('操作原因'),'新增客服同事处理咨询');
await user.click(screen.getByRole('button',{name:'创建邀请'}));
expect(await screen.findByText('邀请已创建，请复制链接发给同事')).toBeInTheDocument();
```

Test fixtures use literal Task 1 DTO envelopes and distinguish endpoints/headers/bodies; returned success changes fixture server state only on valid command to make subsequent query assertions meaningful. Run `npm test -- src/http.test.ts src/team/TeamPage.test.tsx` and record RED.

- [x] **Step 2: Add typed command transport and form lifecycle.** AdminError carries optional known code; preserve requestId sanitization/no raw message display. Reuse same key only for identical failed/unknown submission; changing form resets key. Unknown-result mode freezes submitted inputs, permits exact retry or cancel-with-warning, never silently issues new key. 409 retains inputs but requires reloading current object/version before resubmit. 403 refreshes actor/permissions; 401 existing clear cache path; 503 explains local writes unavailable.

```ts
const submission = { key: crypto.randomUUID(), method, path, body };
const result = await client.command<TeamMutationResult>(
  submission.method, submission.path, submission.body, submission.key, signal,
);
// Save submission in component memory before dispatch; reuse unchanged on unknown-result retry.
```

- [x] **Step 3: Implement members and invitations surfaces.** Use existing Sheet for create/edit/confirmation, Tabs for member/invite tabs, stable pagination and exact email/status/role filtering. Catalog assignableRoles powers choices and permission summaries. Always honor returned allowedActions; explain self/protected/built-in boundaries. Member identity email read-only; separate role assignment from name edit. Invitation row supports edit/rotate/revoke and shows real activation/expiry state. One-time LinkResult supports clipboard and manual selection, no persistence, no fictitious email sent toast.

- [x] **Step 4: Implement role list/editor/detail.** Display built-ins as protected read-only, human names and actual permissions; create/edit custom roles uses permission catalog customRoleAllowed and recursive dependency closure, read-only key after creation, mandatory reason. Removing a dependency removes dependent choices or clearly blocks save. Show affected member/invitation counts, reject deletion-in-use and preserve 409 form.

```ts
function includeDependencies(selected: Set<string>, key: string, catalog: PermissionEntry[]) {
  if (selected.has(key)) return;
  selected.add(key);
  for (const dependency of catalog.find(p=>p.key===key)?.dependencies ?? [])
    includeDependencies(selected, dependency, catalog);
}
```

Implement this pure helper in `RoleEditor.tsx` (or adjacent focused helper if exported test needs it); no runtime ability to select noncustom permissions.

- [x] **Step 5: Implement invitation/reset fragment flow and wire shell.** `readAuthLink(hash:string):{kind:'invite'|'reset';token:string;email:string;displayName?:string}|null` parses only exact known paths and expected token format. Read into memory once, immediately replace URL fragment without token. Extend existing invite form to prefill nonauthoritative email/name; keep server-bound roles. Password reset validates new password/repeat, uses anonymous endpoint, clears secret/password after success, returns to login without granting a session. Preserve MFA and local exceptions and status-refresh behavior.

Wire `/administrators` to TeamPage and `/roles` to RolesPage; other ResourcePage behavior unchanged. Role navigation uses roles.read, labels add super_admin; header uses actual stage/write availability. Button/dialog text uses current blue/white theme and no unrelated redesign. Team errors do not hide the existing readonly business menus.

- [x] **Step 6: Validate all frontend states and regression tests; commit explicit files.** `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`. Include loading/empty/error/readonly catalog, last-super denial, clipboard failure, role dependency and unknown-result tests. Preserve existing auth tests; update fixtures to include new role read permission only where the role truly gains it.

## Task 3: Full local integration, reviewed migration and exact account promotion

**Files:** modify `viviai-admin/scripts/admin-http-smoke.mjs` for relational fixtures; add `viviai-admin/scripts/admin-team-http-smoke.mjs`; README verification notes. Runtime-generated private backup/report files stay gitignored. No user database fixtures.

**Interfaces:** consumes `bootstrapSuperAdministrator`, Task 1 HTTP contracts and actual frontend `AdminClient`; node smoke imports the actual client through existing tsx harness. Existing server launch reads private MFA key without output.

- [x] **Step 1: Write failing actual-client smoke against isolated app.** Create random schema, active super/system/support fixtures, use a cookie-preserving fetch wrapper equivalent to existing admin-http-smoke; never print raw cookies/links/passwords. Assert management creation→GET readback→role assignment→disabled session401→enable→password-reset single use→custom-role in-use409→unbind/delete. Include real MFA invite activation with test-only TOTP secret, and exact local exception login fixture. Exit nonzero for any unexpected status and clean only owned schema.

```ts
const created = await client.command<TeamMutationResult>('POST','/team/invitations',
  {email:'http-teammate@example.test',displayName:'联调同事',roles:['support'],reason:'隔离联调创建成员'}, randomUUID());
const list = await client.get<TeamList<TeamInvitation>>('/team/invitations?q=http-teammate%40example.test');
assert.equal(list.items[0].id, created.resourceId);
assert.equal(list.items[0].status,'pending');
```

- [x] **Step 2: Run integrated checks and independent task/full-increment review.** Test against actual client, not duplicate HTTP helpers only. Run full backend/frontend suites and typecheck/lint/build after all amendments, record counts. Scope independent review to baseline `f0c77a5` through final B1 implementation, including interfaces, migration/rollback, revocation/races and UI unknown outcomes. Correct required findings before live migration.

- [x] **Step 3: Prepare local maintenance safely.** Verify exact frontend3010/backend3011 URLs from known runtime, confirm database points to local55432/viviai_dev, no active payment/model calls. Snapshot migration status and the two staff identities/roles/status/version without secrets. Generate a private0600 PostgreSQL backup with local pg_dump into a uniquely created ignored directory; verify command exit and archive listing before proceeding. Stop only owned admin backend session. Do not kill unrelated listeners or delete runtime key material.

- [x] **Step 4: Apply reviewed migration and promote exact account.** Apply `prisma migrate deploy` to the verified local URL only after backup/maintenance. Start updated owned admin backend using the retained private launcher/config; no new credentials. Invoke the audited promotion service dry-run for weiys01@126.com at its actual version, inspect expected identity/roles, then apply once. No account password/status/MFA/extras changes; preserve second account. If migration fails transactionally, restore old process/code compatibility without destructive improvisation; stop and report if recovery is uncertain.

- [x] **Step 5: Read-only live validation and user handoff.** Login using already authorized existing password in memory, check `/me`, all ten readable modules and team permissions/catalog for first account; second account retains system_admin and can manage ordinary targets but not super. Do not create real invitations/resets as a smoke test. Log out diagnostic sessions and verify401. Confirm frontend3010 responds using lightweight HTTP and preserve same preview. Report which menus are now writable, residual readonly modules, tests and any unresolved constraints. Commit only owned source/doc files; keep worktree and preview, no merge/push/deploy.

## Plan self-review

Spec coverage: §1–3 → Task1 permissions/gates and Task2 shell; §4–5 → Task1 commands and Task2 forms; §6–8 → Task1 migration/transactions/HTTP; §9 → Task2; §10 → Task3; §11 → all task tests. Default password/MFA behavior is retained in Task1 and explicitly regression-tested in Task2/3. All frontend contracts appear above; no new backend endpoint is required by UI without Task1 ownership.

Execution: use a backend implementer and independent task reviews; the root Site owner implements frontend and actual-client integration, as required by the existing-site skill. No additional scope confirmation is needed after the user's approval; review failures are fixed within this scope.
