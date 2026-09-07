# VIVIAI Backend Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver architecture phase A: a runnable PostgreSQL-backed API and asynchronous worker, with real accounts/private uploads, immutable quotes, idempotent image jobs, a conserved credit ledger, and controlled simulated providers.

**Execution status (2026-09-07):** Phase-A implementation and local first-party verification are delivered: 67/67 tests, strict typecheck, build, real PostgreSQL/Redis HTTP smoke 3/3. Task 1 independent review passed. Tasks 2–4 and final independent review are pending because two execution agents hit the same account usage limit; this is not production approval. See `viviai-server/VERIFICATION.md` and the plan-specific SDD ledger for exact evidence and the controller fallback decision. No frontend migration or live API activation was performed.

**Architecture:** Independent `viviai-server/` alongside the existing `viviai-web/`, deployed as API and worker processes. PostgreSQL/Prisma owns durable business state; Redis/BullMQ only delivers scheduling hints. Provider adapters never mutate the wallet, and user settlements do not erase supplier costs.

**Tech Stack:** TypeScript, NestJS, Prisma, PostgreSQL, BullMQ/Redis, Sharp, S3-compatible storage with an explicit local-only filesystem driver, Node.js 22 LTS, Vitest and Supertest.

**Spec:** `/Users/weiys/Documents/ChatGPT/NanoBanana文生图/docs/backend/01-后端架构设计.md`, `02-后端详细设计.md`, `03-多API提供方接入规范.md` in the same directory.

## Global Constraints

- Work only in the existing `codex/viviai-frontend` worktree; do not edit or commit the user's existing frontend/spec changes.
- Implement phase A only; real provider activation, payments, subscription renewal, community and workflow runs remain subsequent phases. Do not create no-op successful routes for absent features.
- No paid model calls, external mail delivery, purchases, deployment, pushing or merging. Default providers must be clearly named simulations, not advertised as real Nano Banana.
- HTTP prefix `/api`, camelCase envelope `{data,message,requestId}`, stable error `code`. Do not expose secrets, raw upstream errors, object keys or password/token hashes.
- Quotes last 5 minutes; generation count 1–4; ordinary queue deadline 5 minutes and delivery deadline 15 minutes; at most 2 upstream attempts per item.
- Reference images: 1 required reference for remix, optional 1 subject; JPEG/PNG/WebP ≤5MB each and ≤40MP decoded. Ownership checked for every read/write/reference. Private images are not static public files.
- Credits are PostgreSQL bigint, nonnegative; lot issued = available + held + consumed + expired + revoked. Per-item freeze then exactly one consume/release. Expired lot releases go to expired, not available.
- One idempotency key per user/operation creates one job. Replays return the original resource before checking quote expiry; different payload returns 409. Canonical hash includes image identities, roles and every effective input parameter.
- PostgreSQL row/advisory locks and unique constraints protect money and dispatch; no external HTTP or storage calls inside database transactions. Fixed lock order wallet → job → item → reservation → lots.
- Unknown submission never triggers blind retry/failover; user deadline releases credits, supplier cost remains unknown/reserved. Late success cannot recharge or change a refunded terminal item.
- Output bytes must be durably stored and validated before asset visibility and credit consumption. Storage retries never resubmit a model request.
- Integration tests use isolated schemas on a task-owned real PostgreSQL instance. Never reset/drop an existing user database or flush unrelated Redis data. Each test suite owns a namespaced queue/schema/storage root.
- Commit only each task's backend files after tests; root design docs and pre-existing dirty files are out of commit scope.

## File ownership and task boundaries

1. Runtime: backend package/config, Prisma bootstrap, database/config/HTTP boundary utilities, object-store ports and drivers, test harness.
2. Identity/assets: account/session/challenge services, private image upload/access, development seed, their migrations and tests.
3. Jobs/wallet/catalog: quote/input validation, credit accounting, job creation/query/cancel/retry, persistent outbox schema and financial tests.
4. Providers/worker: normalized contract, two simulated channel profiles, safe router, dispatch/settlement/recovery, BullMQ runtime, end-to-end tests and runnable documentation.

## Task 1: Runtime, durable infrastructure and test harness

**Files:** Create `viviai-server/package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`, `compose.yaml`, `Dockerfile`, `prisma.config.ts` if required by the selected Prisma release, `prisma/schema.prisma`, migrations, `src/app.module.ts`, `src/main.ts`, `src/config.ts`, `src/shared/database/database.service.ts`, `src/shared/http/{errors,envelope,security}.ts`, `src/modules/assets/object-store.ts`, `src/modules/assets/{local-object-store,s3-object-store}.ts`, `test/helpers/{database,app,storage}.ts`, `test/integration/runtime.test.ts`, `README.md`.

**Interfaces:**

```typescript
// Export transaction type next to DatabaseService; its .client is PrismaClient.
export type DbTransaction = Prisma.TransactionClient;
// DatabaseService exposes client and transaction<T>(fn:(tx:DbTransaction)=>Promise<T>):Promise<T>.
// Config validated from environment, shared by HTTP and worker.
// ObjectStore.put/get/delete never accept a client filesystem path.
export interface ObjectStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
}
// createApp(configOverrides?) returns initialized Nest application; no listen in factory.
// createTestDatabase() returns {url, database, cleanup}; refuses non-test schema deletion.
```

- [ ] Write failing integration tests for `/api/health` envelope and readiness DB failure, invalid production config rejection, actual local store roundtrip/path traversal refusal, and database migration bootstrap. Tests must execute behavior rather than inspect config text.

```typescript
expect((await request(app.getHttpServer()).get('/api/health')).body)
  .toMatchObject({data:{status:'ok'},message:'ok',requestId:expect.any(String)});
await expect(store.put('../outside', new Uint8Array([1]), 'image/png')).rejects.toThrow();
expect(await store.get('test/image.png')).toEqual(new Uint8Array([1,2,3]));
```

- [ ] Run `npm test -- test/integration/runtime.test.ts`; record RED before implementing behavior. Missing initial infrastructure is an expected setup failure, but add observable assertion failures once the harness exists.
- [ ] Implement Nest bootstrap, global response/error boundary, explicit-origin credentialed CORS, body limits, shutdown lifecycle and validated environment. Configure local host 127.0.0.1:3001 by default, production must reject simulation/local-storage/dev-mail flags. Use current compatible stable dependencies resolved from npm and commit lockfile; never global install.
- [ ] Implement private LocalObjectStore with containment checks and atomic file persistence, plus S3ObjectStore using the official SDK with no public ACL. Use local driver only for dev/test; compose supplies PostgreSQL/Redis and optional S3 development storage. No user data storage is placed in public web root.
- [ ] Implement real-DB test harness with unique `viviai_test_*` schema and migration application; teardown verifies schema ownership and uses that schema only. Minimal health probe table is acceptable until task 2 adds domain models.
- [x] Run `npm run build`, `npm test -- test/integration/runtime.test.ts`, commit backend files with `feat(backend): bootstrap API and durable infrastructure`. Report dependency versions, exported interfaces and test RED/GREEN. Completed f0f789f after review fixes, 10 tests passing.

## Task 2: Real accounts and persistent private uploads

**Files:** Create `src/modules/identity/{identity.module,identity.controller,identity.service,session.guard,mail-delivery}.ts`, `src/modules/assets/{assets.module,assets.controller,assets.service,image-validation}.ts`, `src/scripts/seed-dev.ts`; modify `src/app.module.ts`, config, Prisma schema/migrations; create `test/integration/{identity,assets}.test.ts`.

**Interfaces:**

```typescript
// Auth services return public account data; passwords use scrypt/Argon2id with random salts.
// resolveSession(token:string):Promise<{id:string;email:string;username:string}|null>
// requireUser(req) attaches verified userId; never trusts body.userId.
// assets.upload(userId:string, bytes:Uint8Array, name:string):Promise<AssetDto>
// assets.getOwned(userId:string, assetId:string):Promise<AssetRecord>
// assets.readOwned(userId:string, assetId:string):Promise<Uint8Array>
// Export ASSET_STORE dependency token and AssetService for worker composition.
```

- [ ] Add tests: correct/incorrect login, single-use and expired verification challenge, session cookie flags, CSRF origin rejection, cross-user image denial, corrupted and oversized image refusal, real decoded dimensions instead of submitted dimensions, persisted download after constructing a new app instance.

```typescript
expect((await request(app.getHttpServer()).get(`/api/assets/${aliceAsset.id}`).set('Cookie', bobCookie)).status).toBe(404);
expect(upload.body.data).toMatchObject({width:16,height:24,status:'ready'});
expect(await store.get(uploadRecord.objectKey)).not.toHaveLength(0);
```

- [ ] Run focused tests RED. Implement `POST /auth/send-code`, register/login/logout/reset-password, `GET /me`; sessions use hashed opaque tokens and HttpOnly Cookie, secure in production, explicit-origin validation for unsafe requests, credential/IP rate limits using durable or namespaced shared store. Do not rely on client userId. Set challenge TTL 10 minutes, maximum 5 attempts and resend cooldown 60 seconds; enforce attempts transactionally. Mail transport is injected: tests capture locally; dev writes to a private development mailbox directory; production requires configured SMTP. No external email is sent in this task.
- [ ] Implement authenticated `POST /remix-references`, list/detail/content/rename/favorite/delete/restore asset APIs with owner filters. Use Sharp decode limits; require single-frame raster image, re-encode to strip EXIF, persist before ready metadata. Anonymous upload is excluded from this phase and returns AUTH_REQUIRED; document that phase A requires login before upload. Deleting is soft deletion with 7-day restore, pin-aware physical deletion is not run by this phase.
- [ ] Add explicit development account seed requiring user-supplied environment password; no hardcoded public credentials, no automatic production seed. Initial credit grant is supplied through task 3 wallet service, not a second accounting implementation.
- [ ] Run build and focused/full backend tests; commit only backend changes with `feat(backend): add account sessions and private image assets`. Report service signatures and schema fields for task 3.

## Task 3: Quote, wallet and idempotent task acceptance

**Files:** Create `src/modules/catalog/{catalog.module,catalog.controller,catalog.service,input-schema}.ts`, `src/modules/wallet/{wallet.module,wallet.service}.ts`, `src/modules/generation/{generation.module,generation.controller,generation.service,job-serializer}.ts`, `src/shared/database/locks.ts`; extend Prisma schema/migrations, identity public balance integration, seed; create `test/integration/{quotes,wallet,jobs}.test.ts`.

**Interfaces:**

```typescript
// quote(userId,input):Promise<QuoteDto> includes normalized input/hash, unit and total credits.
// jobs.create(userId,inputWithQuote,key):Promise<JobDto>
// jobs.get/list/cancel/retry enforce owner on every resource.
// WalletService.grant(tx,userId,sourceId,amount,expiresAt):Promise<void>
// WalletService.freeze(tx,userId,jobId,itemId,amount):Promise<void>
// WalletService.settle(tx,itemId,outcome:'consume'|'release',now:Date):Promise<boolean>
// All wallet writes are transactional, callable by task 4 within its larger settlement transaction.
```

- [ ] Add real-DB tests for simultaneous same-key submissions (100 requests → one Job/freeze), changed-key payload rejection, replay after quote expiry, balance sufficient for only one of two concurrent jobs, cross-owner/missing reference refusal, 4-item distinct allocations, expired lot release, multiple-lot event keys, partial settlement and duplicate settlement.

```typescript
expect(await prisma.generationJob.count({where:{userId}})).toBe(1);
expect(wallet).toMatchObject({available:880n,held:120n});
// Hand-checked fixture: 4 items x 30 credits, two successes, two releases.
expect(settledWallet).toMatchObject({available:940n,held:0n,consumed:60n});
```

- [ ] Run focused tests RED. Create immutable development catalog product `simulation-image-v1` (display “模拟图片（非 AI）”), one 1024×1024 PNG specification at illustrative 30 credits/item; no live official model advertised as available. Normalized inputs support generation and remix; unknown fields rejected, prompt/role/strength/count/format limits enforced. Simulation catalog is forbidden in production.
- [ ] Implement canonical input digest, 5-minute immutable quotes and POST `/generation-quotes`, GET `/models`. Require ready owned reference for remix and optional distinct subject; do not silently omit either image.
- [ ] Implement bigint lots/reservations/allocations/events with DB check constraints and fixed lock ordering; a one-time development grant is clearly a zero-revenue promotional source. Zero/negative/unsafe amounts rejected. Lot expiry is applied before spending and when releasing held allocations.
- [ ] Implement POST `/generation-tasks` and `/remix-tasks`, GET task/list, queued cancel, failed-item retry via new quote/job. Atomically lock idempotency and quote, freeze per Item, create Job/Item/input snapshot/asset pins, write Outbox and consume quote. No provider/network calls occur here. Poll responses preserve external six-state DTO; actual backend stage supplements it.
- [ ] For executing cancellation record intent and expose cancelRequested; task 4 handles provider capability. Public operations never permit manual success, refund, grant or mock-payment completion. Add user `/point-ledger` and actual wallet balances to `/me`.
- [ ] Run build and tests; commit `feat(backend): add quoted jobs and conserved credit accounting`. Report exact state/schema and transaction interfaces needed by worker.

## Task 4: Safe multi-provider worker and executable end-to-end handoff

**Files:** Create `src/modules/providers/{contracts,registry,router,simulated-provider,provider-config}.ts`, `src/modules/generation/{dispatch.service,settlement.service,recovery.service}.ts`, `src/shared/queue/{outbox-publisher,queue-runtime}.ts`, `src/worker.ts`, `test/integration/{worker,recovery}.test.ts`, `test/e2e/generation.test.ts`, `scripts/smoke.mjs`; update schema/migrations, config and README as needed.

**Interfaces:** Use the normalized ProviderAdapter/SubmitResult/QueryResult/Acceptance/BillingCertainty from spec section 3.1. Copy the interfaces into `contracts.ts`; adapt only if required by executable types, without dropping uncertainty semantics. `dispatch.process(itemId)`, `recovery.scan(now?)`, `outbox.publishBatch()` expose testable real application boundaries; test-only fault injection lives in test adapters/helpers, not public HTTP parameters.

- [ ] Add tests for duplicate delivery, two workers racing one Item, 4-item partial success, safe equivalent-channel fallback after confirmed not-accepted, no fallback after unknown timeout, cancelled queued job never submitted, output storage retry never regenerates, restart recovery from accepted/pending/submitting, expired deadline releasing only user credits while preserving unknown supplier cost, late result not recharging, independent project-quota sharing and budget limits.

```typescript
expect(job.status).toBe('partial');
expect(job.chargedCredits).toBe(60);
expect(await db.providerAttempt.count({where:{itemId:unknownItem.id}})).toBe(1);
expect(await db.creditReservation.findUnique({where:{itemId:unknownItem.id}})).toMatchObject({status:'released'});
expect(await db.providerUsageRecord.findFirst({where:{attempt:{itemId:unknownItem.id}}})).toMatchObject({certainty:'unknown'});
```

- [ ] Run RED. Implement registry and two clearly named simulated provider profiles (sync and async); deterministic valid PNG result labeled simulation through metadata, no real API keys or network requests. Test adapters assert exact received reference/subject bytes and roles. Router hard-filters identity/spec/roles/region/enabled/budget before price; unknown never switches provider and total attempts ≤2.
- [ ] Implement PostgreSQL-authoritative dispatch CAS and fencing, persisted Attempt before submit, per-user slots and shared quota scope, atomic cost reservation. Simulated costs remain separate from real accounting and never claim to be actual paid fees. Persist image output before atomic Asset/wallet/item winner settlement; duplicate outputs and late outputs cannot consume again.
- [ ] Implement Outbox→BullMQ publication with at-least-once behavior, worker reloads DB state on every delivery; scheduled scans rebuild ready/pending/materializing work after queue loss. Persist poll deadlines and jitter; submitting lost lease becomes unknown, not ready. Use bounded error handling, shared graceful shutdown, namespaced Redis keys. Complete cancellation according to capability; never report cancelled until confirmed or business deadline.
- [ ] Implement real network HTTP E2E: create verified development user through injected mail capture, upload reference/subject, quote, submit duplicate, run asynchronous worker, poll completion, authenticated download and verify decoded size, balance and ledger; repeat with failure and unknown. Real DB/Redis, filesystem store for this local test only. Add reproducible `npm run smoke` without paid API.
- [ ] Update README with commands for installation, environment, compose or native local PostgreSQL/Redis, migration, development seed, API and worker, test and smoke. Clearly list phase A complete vs B–E not implemented; expose `/api/health` and OpenAPI/manual contract examples without declaring frontend connected. Keep frontend Mock unchanged until dedicated migration phase.
- [ ] Run build, entire backend test suite and smoke against started API/worker; commit `feat(backend): run recoverable image jobs through provider gateway`. Final reviewer checks whole backend diff; address important findings before handoff.

## Completion evidence

Record exact commands/results and remaining environment limitations in `viviai-server/README.md` or implementation report. Do not call migration files or mocked repositories evidence of real transaction safety. Stop/clean only task-owned temporary services; do not alter existing user daemons. Keep backend source and reproducible local runtime configuration available for the user.
