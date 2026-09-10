# Model-resolution Credit Pricing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make official model/resolution credit prices configurable in the operations console and authoritative for new quotes and submissions, without changing committed job charges or execution routing.

**Architecture:** PostgreSQL stores versioned prices independently of provider execution snapshots. Admin commands reuse current transactional authorization, local write gates, immutable audit and idempotency receipts. The existing console gains a pricing list, per-resolution editor and history; quote/submission transactions serialize against the same per-price lock.

**Tech Stack:** Existing NestJS, Prisma/PostgreSQL, Vitest, React, Vinext, Testing Library and installed UI primitives; Node 22.22.2. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-10-admin-model-credit-pricing-design.md`

## Global Constraints

- 唯一计价维度为“官方模型 ID＋分辨率档位”，同档位下已支持的比例同价。
- 总预估积分＝单张积分×生成张数；积分为 1–1,000,000 整数，张数为 1–4。
- 未定价或停用的规格不得创建新任务，不默认免费，不使用其他模型的价格兜底。
- 调价影响新报价；未提交的旧报价需重新确认；已提交任务按原积分结算，不因单纯调价失效。
- 没有 API Key 也可以先配置积分；价格启用不等于渠道可用，不自动启用模型调用。
- 只修改 `viviai-server`、`viviai-admin` 及本功能的设计/计划文档；保留 `viviai-web` 所有已有修改。
- 不填写真实售价、不调用付费 API、不发送邮件、不修改支付商品、密码、MFA 例外或成员角色绑定。
- Exact local development write gate remains mandatory; only super_admin gains model-pricing.write, which is not custom-role assignable.
- Use existing isolated `codex/viviai-frontend` worktree. No merge, push, deployment, new worktree, public database fixtures or browser automation.
- Root owns all Site/frontend edits; backend implementer owns only server files. Independent read-only review is mandatory for both and for the complete increment.

## Frozen HTTP contracts

All paths below are relative to `/api/admin`. Existing AdminClient envelopes apply. Unknown body/query fields fail validation. Supported specs come only from `officialSpecs(modelId)`; retired records remain history, not offered options.

```ts
type PriceState = {unitCredits: number; enabled: boolean; version: number};
type ModelPriceRow = {
  modelId: string; name: string; provider: string; resolution: string;
  specs: {id: string; resolution: string; ratio: string; width: number; height: number}[];
  priceId: string | null; unitCredits: number | null; enabled: boolean;
  version: number; updatedAt: string | null; runtimeAvailable: boolean;
  availabilityReason: 'unpriced' | 'price_disabled' | 'runtime_unavailable' | 'available';
  allowedActions: {action: 'create' | 'edit' | 'enable' | 'disable'; allowed: boolean; reasonCode: string | null}[];
};
type ModelPriceList = {items: ModelPriceRow[]; asOf: string; writeEnabled: boolean};
type ModelPriceHistory = {
  items: {id: string; createdAt: string; actor: string; modelId: string;
    resolution: string; action: string; before: PriceState | null; after: PriceState}[];
  asOf: string; nextCursor: string | null;
};
type SaveModelPrice = {unitCredits: number; enabled: boolean; expectedVersion: number; reason: string};
type SaveModelPriceResult = {resourceId: string; version: number};
type CreditPriceSnapshot = {priceId: string; version: number; modelId: string; resolution: string; unitCredits: number};
```

- `GET /model-pricing?modelId=…` → ModelPriceList (optional exact modelId).
- `GET /model-pricing/:modelId/:resolution` → ModelPriceRow (unpriced is null price/version 0, not 404).
- `PUT /model-pricing/:modelId/:resolution` with UUID `Idempotency-Key`, SaveModelPrice → SaveModelPriceResult. Initial expectedVersion 0. No-op saves keep version and record audit + receipt.
- `GET /model-pricing/:modelId/history?resolution=…&cursor=…&limit=30` → ModelPriceHistory. Default 30, max 100; stable createdAt/id keyset; register history route before resolution route. No raw reasons or secrets in history.
- Existing `/status` adds optional `modelPricingWritesEnabled: boolean`; retains stage/team flags.
- Existing public quote adds nullable `priceVersion`; existing model catalog shape retained but DB prices/filtering become authoritative.
- New codes `PRICE_CHANGED`, `PRICE_UNAVAILABLE`, `PRICE_VERSION_CONFLICT`; use current local-gate and permission error codes consistently with ActionForm. Missing/disabled quote = 503; stale/disabled submission = 409. Admin version conflict = 409.

## File map

Server persistence: Prisma schema and one additive migration; `src/modules/catalog/credit-pricing.ts` contains shared snapshot/locking/read functions. Admin feature: `src/modules/admin/model-pricing/{contracts,service,controller,import}.ts`, wired in admin module. Existing provider config/runtime, catalog, generation, permission catalog, audit metadata, status/query projection are narrow integration edits. Offline CLI: `src/scripts/admin-import-model-prices.ts`. Tests: `test/admin-model-pricing.test.ts`, `test/model-credit-pricing.test.ts`, `test/model-price-import.test.ts`, plus existing affected official model fixtures/tests.

Console: `src/pricing/{contracts,PricingPage,PriceEditor,PriceHistory}.tsx` (contracts is `.ts`); `PricingPage.test.tsx`, `PriceEditor.test.tsx`; narrow nav, shell, status, model-detail and stylesheet edits. Existing shared ActionForm handles mutation lifecycle; no new generic form framework.

### Task 1: Persist prices and connect admin, quotes and generation atomically

**Files:** Server files in file map; `viviai-server/package.json`, README and admin runbook may document the import and migration. Do not touch console, private `.data`, live config or live database.

**Interfaces:** Produces every frozen HTTP contract above. `CreditPriceSnapshot` is independent of `ExecutionSnapshot`. The shared price advisory lock is keyed by modelId/resolution and is held through transaction completion. Admin uses existing global team → actor → price order; quote uses price; submission uses wallet → price.

- [ ] **Step 1: Add focused failing HTTP and persistence tests.** Start with a real isolated-schema fixture: super_admin PUT unpriced model/resolution at expectedVersion 0 produces version 1; absent permission is 403; list can be read/configured without provider keys; no DB row initially. Use actual routes and DB, not source-string assertions.

```ts
const body = {unitCredits: 120, enabled: true, expectedVersion: 0, reason: '测试模型积分定价'};
const saved = await f.call('PUT', f.superAdmin.cookie,
  '/model-pricing/gpt-image-2/1K', body, randomUUID());
expect(saved.status).toBe(200);
expect(saved.body.data.version).toBe(1);
```

Fixture helper return/envelope details must match inspected `test/helpers/admin-team.ts`; the behavior above is the assertion contract, not permission to invent a new helper. Run focused tests before implementation and record the real RED.

- [ ] **Step 2: Add additive schema and migration, shared lock and price reader.** ModelCreditPrice has UUID id, unique modelId/resolution, int range checks, boolean enabled, positive version, timestamps and nullable updatedBy FK. Quote/job gain nullable JSON creditPriceSnapshot. Only super_admin built-in DB/code permissions gain model-pricing.write; bump affected role version and account authVersion/version, revoke affected sessions/challenges/grants as existing role mutation does; preserve credentials, MFA settings, bindings and extras. Never seed sales values automatically.

```ts
await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`model-credit-price:${modelId}:${resolution}`}, 0))`;
const row = await tx.modelCreditPrice.findUnique({where: {modelId_resolution: {modelId, resolution}}});
// Missing or disabled rows fail closed; caller supplies quote/submission status.
```

- [ ] **Step 3: Implement admin query/history and command.** Validate exact supported tuple, strict numeric positive bounded integer, expectedVersion integer >=0, reason5–500, UUID key. Reuse AdminTeamCommands transactional authorization/receipt; revalidate permission and local gate before replay. Lock price; compare version; create/update or preserve no-op version; atomically audit safe before/after metadata and receipt. Add metadata whitelist. List enumerates supported official specs independently of configured credentials; runtime readiness is separate. History projects audit safely, includes offline source, and uses stable scoped cursor. Denied/conflict audit retains current minimal redaction. Same-key conflicting payload must fail; concurrent distinct creates must produce one winner.

- [ ] **Step 4: Decouple runtime from legacy sales.** Add optional enabledResolutions; explicit list wins, absent falls back to legacy sales keys only. Validate nonempty supported keys and preserve credentials/cost limits. Strip sales values and all DB price metadata from channel fingerprint and new execution snapshot; actual execution config still affects identity. Add tests that 100→200 legacy sale values cannot alter channelId, while protocol/output/credential changes can.

```ts
const enabled = configured.enabledResolutions ?? Object.keys(configured.sales ?? {});
const executionModel = {modelId: configured.modelId, enabledResolutions: [...enabled].sort(),
  reserveCostMicros: configured.reserveCostMicros, pricing: configured.pricing};
// Hash executionModel, output and current account/revision, never configured.sales values.
```

- [ ] **Step 5: Wire live catalog, quote, submission and admin model detail.** Catalog asynchronously filters configured reviewed specs by active DB price. Quote obtains execution + price under price transaction lock, writes independent snapshots and BigInt totals, returns priceVersion. Submission replays prior idempotent job first; locks wallet then price, checks quote snapshot consistency/current version/active state, requires refresh for old official quotes, then freezes from quote amounts and copies both snapshots. Persisted job settlement/dispatch remains old-price and old-execution. Simulation keeps isolated30 fixture path, never official fallback. Existing models/details expose DB price or no price, never legacy sales values.

- [ ] **Step 6: Build explicit dry-run legacy import and expanded tests.** Import parses legacy configured sales without credentials/API calls; validates white-listed tuples and integer ranges, default dry-run; apply creates missing only, does not overwrite even disabled rows, audits each inserted row transactionally with offline source. Cover replay/no-op/concurrency, permission dependency/customrole denial, env/origin/IP gates, immutable history, cursor/query validation, rollback, two independent app instances, quote race outcomes, stale/disabled quotes no freeze, submitted job after reprice/disable, partial failure release, original execution costs, old null snapshots, import dry-run and idempotence, additive migration preservation. Use short focused test runs during iteration; one full server test/build pass before report.

```sh
PATH=/Users/weiys/.nvm/versions/node/v22.22.2/bin:$PATH npm test -- --reporter=dot
PATH=/Users/weiys/.nvm/versions/node/v22.22.2/bin:$PATH npm run build
```

Use only random test schemas from existing helpers, DB localhost:55432/viviai_dev and Redislocalhost:56379; unique `/private/tmp` assets/mailbox. Do not mutate public schema. Commit only explicit server files, self-review, report RED/GREEN commands, counts and concerns. Root dispatches independent review before acceptance.

### Task 2: Build pricing console with guarded forms and history

**Files:** Console file map, existing `src/{navigation,ConsoleShell,AdminApp,contracts,DetailPage,format}.ts(x)` and `app/globals.css`; existing tests only for changed assertions.

**Interfaces:** Consumes frozen admin contracts. PricingPage takes `{client:AdminClient;actor:AdminActor;writeEnabled:boolean;onPermissionsChanged:()=>Promise<void>;initialModelId?:string}`. Uses `ActionForm` PUT with initialVersion0 for new rows, `onReload` returns `{version,summary}` while preserving local draft. PriceHistory loads scoped model/res history; no write controls without writeEnabled, actor permission and allowedActions.

- [ ] **Step 1: Write failing component tests for list and editor.** Use Testing Library/AdminClient mock-boundary fixtures: unpriced/read-only/API-not-ready states, supported specs, exactmodelfilter, detailslink, integer errors, selectedresolution total preview, valid PUT with reason/version/key and no ratio/quality payload; history paging and errors.

```tsx
render(<PricingPage client={client} actor={actor} writeEnabled onPermissionsChanged={refresh} />);
expect(await screen.findByText('API 未就绪')).toBeInTheDocument();
await user.click(screen.getByRole('button', {name: '配置 gpt-image-2 1K'}));
await user.type(screen.getByLabelText('单张积分'), '120');
await user.type(screen.getByLabelText('操作原因'), '测试积分定价');
await user.click(screen.getByRole('button', {name: '保存价格'}));
expect(command).toHaveBeenCalledWith('PUT', '/model-pricing/gpt-image-2/1K',
  {unitCredits:120, enabled:true, expectedVersion:0, reason:'测试积分定价'}, expect.any(String), expect.any(AbortSignal));
```

- [ ] **Step 2: Implement list/editor/history using installed components.** Keep blue/white admin tokens, compact horizontally scrollable table, side-sheet forms, readable labels. New defaultenabledtrue only in unsaved draft; examplecount1–4; old→new display and committed-job warning. Strict integer validation before ActionForm submit; empty price is not0. All state-dependent actions use authoritative allowedActions. Load failures show retry, never mock/fallback. History read-only shows actor/time/before/after with independent loading/error/page state; omit secretreason.

- [ ] **Step 3: Wire navigation, model-detail link and status.** Add menu under模型运行, permissionmodels.read, route `/model-pricing` with querymodelId parsed safely and exactreadpermission. Update shell icon map/order, breadcrumbs/header/footer to show pricing availability without claiming other modules writable. API/model runtime readiness copy must not promise successful generation. Existing status noflag defaultsfalse.

- [ ] **Step 4: Cover lifecycle regressions.** Tests for 409draftpreservation/reload/newversion, 403permissionrefresh/editorclear by authcontext, 401clientinvalidates, uncertainresult freezes fields and repeats samekey, disabledprice/re-enable, no-op, history refresh aftercommit, no writes throughreadonly UI, authloss cancellation. Add actual frontend AdminClient + backend local HTTP smoke in isolatedschema as integration proof (root may place under server test with narrow coordination).

- [ ] **Step 5: Run console test/build once, scoped commit and independent review.** Capture real RED/GREEN; preserve usermockfiles. Use `npm test` and `npm run build` with Node22 path. No automated browser activity.

### Task 3: Final review, safe local activation and handoff

**Files:** This plan result section; only ignored owner-private maintenance scripts/runtime logs/backups as needed, never tracked secrets.

**Interfaces:** Completed Task1/Task2 committed increment; current local server launcher and exact verified database. No price rows are created for live demonstration.

- [ ] **Step 1: Independent final full-increment review.** Most-capable reviewer reads spec, plan, task reports and diff; review security/financial correctness, interactions and contract mismatches. Review read-only, no repeated known-suite tests. Fix all important findings with focused regression + scoped re-review, then run affected full-suite/build checks.
- [ ] **Step 2: Recheck safe maintenance conditions read-only.** Resolve current owned3011 process/worker/launcher, exactdevelopmentDB, migrationstatus, countsnonterminaljobs/providerattempts/paymentoperations and legacyofficialsnapshots; capture account role/credential digests and pricecounts without outputting secrets. If in-flight/unknown productionstate, stopactivationandreport, do notcancel/rewriteuserjobs.
- [ ] **Step 3: Back up and apply additive migration locally.** Stop verified owned backend/worker only when safe; use fresh0700dir +0600pg_dump backup of public schema; never touch oldbackups/key. Run Prisma migrate deploy only at verifiedlocalhostDB. Restart sameprivate launcher, preservingkeys/config/passwordexception. No importapply without actual chosenpricingdata.
- [ ] **Step 4: HTTP readiness and existing-account verification.** Verify `/status`pricinggate, authenticate the two existing accounts locally withoutprintingcookies/tokens, confirm super permission and secondaccount unchanged, verify pricinglist unpriced/API-not-ready and admin-model views; signouttestsession. No mutations beyond migration or price testfixtures inpublicDB.
- [ ] **Step 5: Persist evidence and finish.** Record test/build counts, review SHAs/results, local activation and backup evidence, unchangeduserfileboundary. Keep local preview running. Clean only this plan's scratch after reportevidencepersisted; no broad cleanup. Final usermessage gives entry, behavior, no configuredprices/APIkeys, usermockscope and concise rulings.

## Plan self-review

Spec sections1–2 → globalconstraints and Task1; UI/permissions3 → Tasks1–2; schema/audit4 → Task1steps2–3; routes5 → frozencontracts; transactions/runtime6 → Task1steps4–5; migration7 → Task1step6 +Task3; scope8 → globalconstraints; acceptance9 → teststeps +review. No uncovered requirements identified. Contract names centralized above. Existing user dirty paths are excluded from all tasks.

## Execution evidence

Baseline (2026-09-10): server265/265 tests,30files; console90/90,12files. No implementation mutations at baseline. User explicitly approved implementation; no further approval cycle required.
