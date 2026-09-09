# Operations Console A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved internal team's local, real-backend read-only operations console, with isolated administrator authentication, MFA, scoped queries and audit.

**Architecture:** Add a NestJS AdminModule alongside the existing business modules; preserve the PostgreSQL business ledger as sole authority. A separate `viviai-admin` frontend uses same-origin `/api/admin` requests and no MSW or fallback data. Backend task and owner-authored frontend have disjoint file ownership and a fixed table/detail HTTP contract.

**Tech Stack:** Existing Node 22.22.2, NestJS 12, Prisma/PostgreSQL, native crypto, Vitest; React 19 and existing Vinext/Shadcn template conventions for the independent local frontend. No new identity provider, D1, payment or model connection.

**Spec:** `docs/superpowers/specs/2026-09-09-operations-platform-design.md` (user approved development 2026-09-09).

## Global Constraints

- Implement A only. B/C financial mutations, provider recovery/pause, price/config publication, exports and content/workflow administration remain unavailable, not mocked as success.
- Worktree `/Users/weiys/Documents/ChatGPT/NanoBanana文生图/.worktrees/viviai-frontend`, branch `codex/viviai-frontend`; preserve the 16 pre-existing dirty user-frontend/spec files. No merge, push, hosting registration, deployment, live credentials, real staff account creation, paid model calls or payment actions.
- The site-owning controller alone edits `viviai-admin`. Backend implementer owns only `viviai-server` and its ignored report; no nested agents. Existing Sites-owned user frontend and its hosting metadata are untouched.
- No browser screenshots/DOM automation requested. Validate through components and HTTP integration, not CUA. Open only a compiled coherent local preview, not a starter skeleton.
- Separate administrator identity, invitation-only, MFA required. Invitation 24h; pre-auth challenge 10 minutes, five failed verifications; session idle 30 minutes/absolute 8h; grant 5 minutes. Roles re-evaluated on every request.
- Native crypto TOTP: SHA1, 6 digits, 30-second step, ±1 step; persist last accepted counter to reject replay. AES-256-GCM encrypts per-account secrets with account ID as AAD; use fresh 12-byte IV. Recovery codes use 128-bit random entropy and one-time hashes. Passwords 12–128 characters, scrypt, no fixed credentials.
- Body/DTO validation is strict, all mutation/auth requests enforce the admin-specific Origin allowlist, cookies HttpOnly/SameSite=Strict/Host-only; Secure in production and a documented HTTP-local development exception. Ordinary `viviai_session` cannot authorize admin routes.
- `ADMIN_ENABLED=false` default. When enabled require `ADMIN_ORIGINS` and a 32-byte base64 `ADMIN_MFA_ENCRYPTION_KEY`; errors never contain keys. Production admin activation remains refused in this local increment until external audit archival/retention and deployment security are accepted; document the boundary, do not silently downgrade security.
- Timestamps UTC ISO; display Asia/Shanghai. Credits/CNY minor units/USD micros serialize as decimal strings. No raw Prisma spreads, prompt/input JSON, object keys, credentials, hashes, provider response bodies or cookie tokens in regular DTOs/audit.
- Cursor pagination default 30/max 100 with deterministic `(createdAt,id)` order; strict date ranges and exact-ID/email/order-number searches. No full-text prompt search. Role checks on resource, action and sensitive field.
- No direct balance edits, cash refunds, retry generation or manual status overrides. Query alerts may maintain operational projections, but never mutate business facts.
- TDD: observe behavior failure before implementation, focused regression per change; controller performs final full-suite/build/typecheck/smoke. Use isolated owned test schemas; never migrate/reset the user's public schema to run tests.

## Fixed frontend/backend HTTP contract

All paths below are relative to `/api/admin`, wrapped by the existing success `{data,message,requestId}` envelope; errors additionally contain `code`. The original plan incorrectly assumed `code` existed on every success; inspection of the unchanged serializer corrected this during integration. Binary private media is unwrapped. New types are defined in backend `contracts.ts` and mirrored without server imports in frontend `src/contracts.ts`.

```ts
type Cell = string | number | boolean | null;
type Kind = 'text' | 'status' | 'datetime' | 'credits' | 'cny' | 'usd';
interface Column { key: string; label: string; kind?: Kind; link?: 'users'|'orders'|'jobs'|'attempts' }
interface AdminTable {
  title: string; columns: Column[]; rows: Array<{id:string} & Record<string,Cell>>;
  nextCursor: string|null; asOf: string; notices: string[];
}
interface AdminDetail {
  id:string; title:string; fields:Array<{label:string;value:string|null;kind?:Kind}>;
  tables:AdminTable[]; notices:string[];
  sensitive?:{jobId:string;assetIds:string[]};
}
interface AdminActor {
  id:string; email:string; displayName:string; roles:string[];
  permissions:string[]; sessionExpiresAt:string;
}
interface Dashboard {
  asOf:string; environment:string; metrics:Array<{key:string;label:string;value:string|null;kind?:Kind;note:string;href?:string}>;
  alerts:AdminTable; notices:string[];
}
```

Authentication:
- GET `/status` → `{enabled:boolean,environment:string,stage:'A'}`; public, no account list or credential health.
- GET `/me` → AdminActor or 401. POST `/auth/login` `{email,password}` → `{next:'mfa'|'enroll',expiresAt:string,secret?:string,otpauthUri?:string}`; opaque pre-auth HttpOnly cookie only, never full session before MFA.
- POST `/auth/invitations/accept` `{token,email,displayName,password}` → same enrollment response. Consume invitation once, bind email, retain recoverable pending account; a subsequent valid password login can resume enrollment with encrypted pending secret, not strand the invite recipient after a lost response.
- POST `/auth/mfa/verify` `{method:'totp'|'recovery',code}` → `{account:AdminActor,recoveryCodes?:string[]}`; setup requires TOTP, not recovery. Initial recovery codes only returned at successful enrollment. Issue a new full-session cookie; remove/revoke pre-auth. POST `/auth/logout` → `{success:true}`; revoke both cookies.
- Frontend keeps secrets/password/recovery only in temporary React state. Invitation token may be read from `#/accept?token=...`, then removed with replaceState after acceptance; no localStorage/sessionStorage or query-string server logging.

Read routes: GET `/dashboard`, `/users`, `/users/:id`, `/users/:id/credit-lots`, `/users/:id/credit-events`, `/orders`, `/orders/:id`, `/jobs`, `/jobs/:id`, `/attempts/:id`, `/models`, `/models/:id`, `/provider-accounts`, `/alerts`, `/audit-events`, `/administrators`, `/roles`. Lists return AdminTable; details return AdminDetail. Query `{cursor?,limit?,q?,from?,to?,status?,userId?,modelId?,source?}` accepts only relevant keys per route. All A read routes expose no mutating allowed actions.

Sensitive routes: POST `/sensitive-access-grants` `{jobId,reason}` → `{id,expiresAt}` requires explicit `sensitive.read`, owned case context via exact job ID, reason 10–500 chars, audit before issuance. GET `/jobs/:id/sensitive?grantId=...` → `{prompt:string,assets:Array<{id,role,width,height,previewPath}>}` verifies same admin/session/job and valid grant; GET `/assets/:id/preview?grantId=...` rechecks these plus job asset relationship and ready/nondeleted state; streams private bytes with `Cache-Control:no-store`. Recheck role/status even if grant exists. Grant ID is not sufficient without session. No bulk grants or external image URLs.

Roles are predefined permission templates stored per account, with validated optional `sensitive.read` binding granted only by the offline initial invitation process. Owner: all A read categories but not sensitive; support: service dashboard/users/orders/credits/jobs/service alerts, no costs/audit; finance: financial dashboard/users/orders/credits/jobs/costs, no raw media; model_operator: model dashboard/models/providers/costs/model alerts, no users/jobs; content_operator: empty content dashboard marked not integrated; system_admin: system dashboard/admins/roles/audit, no customer records. `GET /me` returns exact permission strings: `dashboard.read`, `users.read`, `orders.read`, `credits.read`, `jobs.read`, `models.read`, `providers.read`, `costs.read`, `alerts.read`, `audit.read`, `admins.read`, `sensitive.read`; dashboard field selection and alerts are additionally role-scoped.

## Task 1: Isolated admin backend, scoped read models and audit

**Owner:** backend implementer (high-risk integration), not allowed to edit either frontend.

**Files:**
- Create `viviai-server/src/modules/admin/{admin.module,config,contracts,crypto,permissions,audit.service,auth.service,auth.controller,session.guard,query.service,query.controller,sensitive.service,sensitive.controller,bootstrap}.ts`. Split query implementation into `{users,orders,jobs,models,overview}.queries.ts` if needed; each owns its named queries.
- Create `viviai-server/src/scripts/admin-bootstrap.ts`, `viviai-server/ADMIN.md`, `viviai-server/test/admin-crypto.test.ts`, `viviai-server/test/integration/{admin-auth,admin-queries,admin-sensitive}.test.ts`, test-only fixtures in `test/helpers/admin.ts`.
- Modify `prisma/schema.prisma`, add `prisma/migrations/20260909220000_admin_console_a/migration.sql`, `src/config.ts`, `src/app.module.ts`, `src/shared/http/security.ts`, `.env.example`, `package.json` (bootstrap script only; no unnecessary SDK dependencies).
- For actual lifecycle events add a narrowly scoped event writer and calls in generation dispatch/settlement transactions; preserve business state, lock ordering and baseline tests. Do not invent historical event timestamps.

**Interfaces:** consumes existing DatabaseService, AppError/envelope, ObjectStore and application config; produces the fixed HTTP contract above. Use `AdminModule` to export nothing requiring user SessionGuard. Admin config optional in AppConfig to preserve fixtures. All admin routes, except `/status`, disabled fail closed when config is off.

- [ ] Write failing behavioral integration tests against real `createApp` and a fresh schema before routes exist. Example (fixture helpers live only in tests):

```ts
it('does not let a normal user session read administrator customer queries', async () => {
  const response = await request(app.getHttpServer())
    .get('/api/admin/users').set('Cookie', normalUserCookie);
  expect(response.status).toBe(401);
  expect(JSON.stringify(response.body)).not.toContain('customer-private@example.test');
});
it('does not issue a business session until MFA is verified', async () => {
  const first = await request(app.getHttpServer()).post('/api/admin/auth/login')
    .set('Origin','http://localhost:3010').send({email:'ops@example.test',password:'test-only-long-password'});
  expect(first.body.data.next).toBe('mfa');
  const denied = await request(app.getHttpServer()).get('/api/admin/users')
    .set('Cookie',first.headers['set-cookie']);
  expect(denied.status).toBe(401);
});
```

- [ ] Run `PATH=node22 DATABASE_URL=local55432 REDIS_URL=local56379 npx vitest run test/integration/admin-auth.test.ts`; observe absent behavior failure, not a test typo. Add unit RFC vectors (e.g. 59s SHA1 eight-digit vector 94287082, six-digit 287082), encryption tamper/AAD mismatch tests and counter replay behavior before crypto implementation.
- [ ] Add minimal additive schema: AdminAccount (active/pending/disabled, normalized unique email, passwordHash, roles/extraPermissions validated, encrypted MFA secret, lastTotpCounter, authVersion), AdminInvitation (tokenHash unique, email/roles, expires/consumed), AdminChallenge (tokenHash, expires, attempts, bound account/version), AdminSession (tokenHash, created/lastSeen/expires, authVersion), AdminRecoveryCode (one-time hash), AdminAuditEvent (append-only SQL trigger rejects UPDATE/DELETE), AdminSensitiveGrant (session/account/job, reason, expires), AdminAlert (stable sourceKey, first/lastSeen, resolved), GenerationLifecycleEvent (unique item+event, actual timestamp). No automatic staff seeds or business-data backfill.
- [ ] Implement crypto with Node primitives, strict lengths/encodings and RFC-derived tests. Use fixed-cost missing-account password path, per-IP and per-credential durable rate buckets; account lock protects challenge attempts, TOTP replay, recovery-code consumption, session issuance, invitation acceptance. Auth failure counters and audit must commit, not roll back inside thrown transactions. Concurrent recovery code or TOTP acceptance succeeds once.
- [ ] Implement invitation/login/enrollment/MFA/logout. Enrollment secret only returned for pending account after invitation/password proof. Persist recovery hashes before returning plaintext once. No full token response. Use distinct cookies scoped `/api/admin`; production Secure with localhost exception. Admin Origin allowlist is independent from consumer origins and applies to all unsafe admin routes, including login and grants. Shared CORS may list both sets but admin requests enforce their own boundaries; no wildcard, arbitrary forwarding or relaxation of payment webhook restrictions.
- [ ] Implement read models using strict `select` plus explicit DTO construction. Users/credits show masked emails and genuine batch values; orders never expose checkout URLs/merchant secret or verification payload; jobs omit prompt/raw execution/request and show Item/Attempt status, dimensions, timing events; costs omitted entirely without permission. Models list all five known definitions with enabled vs disabled and exact specs, not only active public catalog; providers show config/usage budgets, not fabricated provider balances. Disabled models never appear verified/live because code exists.
- [ ] Implement dashboard role-aware metrics: genuine SQL counts and sums, simulated vs real separation, explicit unavailable/null refund/fees/profit/unsupported timestamps; zero is only real zero. Alerts read/upsert deduplicated projection for unknown active attempts, deadline-overdue held reservations, missing local materialization and budget≥80%; no business mutation. Account scope correctly aggregates models without summing duplicate quotas. Future alarm-rule editing/notifications remain unavailable.
- [ ] Implement scoped audit list (owner/system_admin), admin/role read lists and exact-search/pagination tests; no generic unbounded queries. Read sensitive grant must audit before content release, require reauthorization on each use and relationship to pinned inputs/result assets. Stream only private stored bytes, never fetch arbitrary URL. Wrong user/job/session/expired grant →404 or403 safely, no preview data. Audit cannot include raw reason secrets accidentally copied from credentials: schema has reason length limits, no raw request body logging.
- [ ] Add offline initial bootstrap CLI requiring exactly two distinct explicit emails and roles; generate one-time invites only when no admin/invite bootstrap exists; refuse repeat population and no default staff account/password. Provide separate explicit revoke-account command for emergency deactivation/authVersion bump with audit, not a role elevation path. CLI may deliver generated tokens via explicit owner-only output destination/invitation mail workflow, not global logs; document use without executing real staff creation. No production admin activation in A local release.
- [ ] Test malformed auth, Origin separation, MFA enrollment resume, invite reuse/expiry, challenge expiry/attempt exhaustion, TOTP/recovery replay/concurrency, session idle/absolute expiry, revoked role/account, audit failure, strict cursor/date input, large money serialization, all role projections, private asset expiry/nonmembership and no raw secrets. Use actual service and DB, mock only external I/O boundaries.
- [ ] Run focused admin tests then server typecheck/full suite once; self-review, commit only owned source/docs/migration/tests. Write exact RED/GREEN and limitations to task report; no ignored reports staged. Record no real API calls and no public-schema migrations.

## Task 2: Owner-authored independent operations UI and integrated local handoff

**Owner:** controller, Sites site owner. Backend task may work independently; do not claim integration complete before Task 1 review resolves contract/security findings.

**Files:** create `viviai-admin` with sanitized existing frontend template conventions, no copied customer features/MSW/hosting project ID. Own `package.json`/lockfile, `vite.config.ts`, `tsconfig.json`, `.gitignore`, `app/{layout,page,globals}.tsx/css`, needed matching `components/ui` primitives, `lib/utils.ts`, `src/{contracts,http,AdminApp,AuthScreen,ConsoleShell,ResourcePage,DashboardPage,DetailPage,ModelSpecs,SensitiveView}.tsx/ts`, test setup/tests and README. Split UI helpers for formatting and table rendering; no giant generic JSON dump.

**Interfaces:** consumes fixed contract above through same-origin fetch with credentials and an AbortSignal. No backend Prisma/secret imports, cookie reading, raw key storage or hardcoded model IDs for capabilities. No mutation endpoints except auth/grants. Local frontend uses port 3010 strictPort; `/api/admin` proxies to configured local backend without changing Origin. Keep user frontend on port3000 untouched.

- [ ] Write tests for HTTP envelope parsing and 401 account/cache clearing, resource loading/error/pagination, support vs finance navigation, money formatting preserving large integer precision, model matrix unsupported cells, and MFA/enrollment/recovery flow before production UI. Representative test:

```tsx
it('shows an unavailable metric instead of inventing profit', async () => {
  render(<DashboardPage dashboard={{asOf:'2026-09-09T00:00:00Z',environment:'test',
    metrics:[{key:'profit',label:'贡献毛利',value:null,note:'成本尚未对账'}],
    alerts:emptyTable,notices:[]}} />);
  expect(screen.getByText('成本尚未对账')).toBeInTheDocument();
  expect(screen.queryByText('¥0.00')).not.toBeInTheDocument();
});
```

- [ ] Run targeted UI tests RED; create narrow HTTP wrapper `adminFetch<T>(path,{method?,body?,signal?})` that validates the envelope, surfaces safe errors and requestId, uses no automatic write retry. Fetch status and me; disabled/error/login are different screens. Abort previous protected queries and invalidate generation/account key on logout/401 to prevent late-response data reappearance.
- [ ] Create first coherent login/enrollment surface with the approved palette: background #F3F5F8, white surface, text #182230, muted #667085, blue #2459DB, borders #DFE4EC. System Chinese fonts with tabular numbers. Functional admin login, disabled-backend notice and enrollment guidance; no illustrative hero or fabricated metrics. Start dev, require exact printed Local URL non-error HTTP response, open once, then keep same preview.
- [ ] Complete MFA setup QR/manual code, recovery-code acknowledgement and login recovery-code option; no secrets in browser persistence. Only reveal recovery codes returned from successful initial enrollment. Hash routing with safe relative resource paths, remove invitation token from URL after acceptance, clear secret fields at transition/logout.
- [ ] Build 224px sidebar and precise-search topbar with actual role-based routes. Render available home/user/order/job/model/provider/alert/audit/admin/role screens. Use semantic matching existing Shadcn table/tabs/sidebar/sheet/input-otp/select primitives copied from the retained template when needed, preserving their behavior. Disabled later-stage finance controls are not clickable fake flows; omit unavailable phase routes rather than build placeholders.
- [ ] Tables support server cursor next/previous stack, filters and refresh; requests cancel stale results. Details render named fields, nested Item/Attempt and credit tables, not sensitive JSON. Task/order/user links carry explicit identifiers and clear views before loading. Model details render resolution×ratio matrix using backend actual specs; unsupported cells remain unavailable. No pixel recalculation.
- [ ] Add per-task sensitive access form only when permission exists. Require reason and grant, fetch sensitive metadata, load previews with authenticated grant. On expiry, role/account invalidation, route change or unmount remove prompt/images and revoke object URLs; use server expiry plus local timer, not merely server rejecting future fetches while old content remains onscreen.
- [ ] Run component suite, strict typecheck and build. Run a real HTTP integration smoke covering backend admin invite/MFA/me/list/detail/grant in isolated test schema with no staff in public DB; assertion IDs/data obey both contract and role boundaries. Do not use browser visual QA without user request.
- [ ] Write local setup instructions: enable config with a fresh key in secret storage, exact admin Origin/proxy, migrate only via user's normal deploy workflow, offline invite workflow, no default admin. Record actual verification, frontend login preview URL, and incomplete external audit/production readiness. No real model keys needed for this phase.
- [ ] Independent task review and full cross-cutting review; fix findings with regressions, re-run final backend tests/typecheck/build/smoke and UI tests/typecheck/build. Preserve pre-existing dirty files, no push/deploy. Update approved spec status and plan checkboxes truthfully.

## Verification commands

Server (Node22 PATH explicit): `DATABASE_URL=postgresql://viviai@127.0.0.1:55432/viviai_dev REDIS_URL=redis://127.0.0.1:56379 npm test`, `npm run typecheck`, `npm run build`, `npm run smoke`, `npm run format:check`.

Frontend: `npm test`, `npm run typecheck`, `npm run build`; use local-only dev command and strict port3010. CLI tests invoke scripts with isolated owned DB and explicit test-only arguments, no production secrets.

## Spec coverage and preflight

A maps to Task1 auth/queries/audit/media/initial bootstrap and Task2 all A UI/verification. B/C/D/E are deliberately absent. Shared interface is only the fixed HTTP contract; file ownership is disjoint. Production audit archiving, high-volume load test and actual staff setup remain production acceptance dependencies, not claims made by the local development gate. Tests must separately prove auth isolation, safe DTOs, unknown states and native model matrix.
