# Workflow and Batch API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist user workflows and execute selected rows as authoritative, quoted, credit-safe batches of ordinary generation jobs.

**Architecture:** Store workflow definitions with optimistic versions and immutable run snapshots. An aggregate workflow quote owns per-row/per-output generation quotes; batch submission consumes them atomically, creates linked generation jobs, freezes credits, and lets the existing worker execute each job independently while a projection service maintains batch progress.

**Tech Stack:** TypeScript, NestJS, Prisma/PostgreSQL, Zod, Vitest, React, TanStack Query, existing generation/catalog/wallet/provider services.

**Spec:** `docs/superpowers/specs/2026-09-12-viviai-non-payment-full-api-design.md`

## Global Constraints

- Complete the account-engagement, content-operations, and AI-tool execution plans first.
- Version 1 supports reference columns plus independent generation/tool output columns. Output columns may consume reference columns, but may not depend on another generated output; reject such graphs with `422 INVALID_WORKFLOW_GRAPH`.
- Every batch item has one model, resolution, ratio, count, normalized generation input, quoted credits, and immutable workflow snapshot.
- Batch submission is all-or-nothing: consume aggregate quote, create all initial jobs, and freeze all credits in one database transaction.
- Batch execution may finish partially; settle each generation item independently and release credits for failed/cancelled work.
- Retrying failures creates a new retry run linked to the original; it never mutates successful history or reuses a consumed quote.
- Do not change payment behavior.

---

### Task 1: Persist workflows, aggregate quotes, runs, and run items

**Files:**
- Modify: `viviai-server/prisma/schema.prisma`
- Create: `viviai-server/prisma/migrations/20260912040000_workflow_batches/migration.sql`
- Modify: `viviai-server/test/helpers/database.ts`
- Test: `viviai-server/test/integration/workflow-schema.test.ts`

**Interfaces:**
- Produces: `Workflow`, `WorkflowRow`, `WorkflowRunQuote`, `WorkflowRunQuoteItem`, `WorkflowRun`, and `WorkflowRunItem` Prisma models.
- Produces: links from each run item to one generation quote and one generation job.

- [ ] **Step 1: Write failing uniqueness and lifecycle tests**

```ts
it('keeps stable row ids unique inside one workflow', async () => {
  await db.workflowRow.create({ data: { workflowId, rowKey: 'row-1', sortOrder: 0, cells: {} } });
  await expect(
    db.workflowRow.create({ data: { workflowId, rowKey: 'row-1', sortOrder: 1, cells: {} } }),
  ).rejects.toMatchObject({ code: 'P2002' });
});
```

Also assert one quote item per `(quoteId,rowKey,columnKey)`, one run item per `(runId,rowKey,columnKey)`, one job per run item, unique user/idempotency keys, and non-negative progress counts.

- [ ] **Step 2: Run the schema test**

Run: `cd viviai-server && npm test -- test/integration/workflow-schema.test.ts`
Expected: FAIL because workflow models are missing.

- [ ] **Step 3: Add the workflow definition models**

Use `externalId`/`rowKey` as client-stable identifiers, UUID database primary keys, `columns` and `cells` JSON, `version >= 1`, `archivedAt`, and owner-scoped indexes. Selected state and live task status are UI/run state and must not be persisted in `WorkflowRow`.

- [ ] **Step 4: Add aggregate quote and immutable run models**

`WorkflowRunQuote` stores `inputHash`, `workflowVersion`, `totalCredits`, `expiresAt`, and `consumedAt`. Each quote item stores the normalized input, origin snapshot, unit/total credits, and its linked `GenerationQuote`. `WorkflowRun` stores counts, `cancelRequested`, `retryOfRunId`, and workflow snapshot; `WorkflowRunItem` stores row/column keys, status, error code, and job link.

- [ ] **Step 5: Write SQL checks and indexes, generate Prisma, and rerun tests**

Run: `cd viviai-server && npm run prisma:generate && npm test -- test/integration/workflow-schema.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit workflow persistence**

```bash
git add viviai-server/prisma/schema.prisma viviai-server/prisma/migrations/20260912040000_workflow_batches viviai-server/test/helpers/database.ts viviai-server/test/integration/workflow-schema.test.ts
git commit -m "feat(server): persist workflows and batch runs"
```

### Task 2: Implement workflow CRUD with optimistic concurrency

**Files:**
- Create: `viviai-server/src/modules/workflow/workflow.module.ts`
- Create: `viviai-server/src/modules/workflow/workflow.controller.ts`
- Create: `viviai-server/src/modules/workflow/workflow.service.ts`
- Create: `viviai-server/src/modules/workflow/workflow-contracts.ts`
- Create: `viviai-server/src/modules/workflow/workflow-presenter.ts`
- Modify: `viviai-server/src/app.module.ts`
- Test: `viviai-server/test/integration/workflows.test.ts`
- Test: `viviai-server/test/integration/workflow-races.test.ts`

**Interfaces:**
- Produces: create/list/detail/update/copy/archive user APIs.
- Produces: `parseWorkflowDefinition`, `validateWorkflowGraph`, and `WorkflowDto`.

- [ ] **Step 1: Write failing CRUD and concurrent-save tests**

Test ownership, strict columns/cells, duplicate keys, dangling source columns, unsupported generated-output dependencies, create, copy, soft delete, and two updates using the same version where exactly one succeeds.

- [ ] **Step 2: Run focused workflow tests**

Run: `cd viviai-server && npm test -- test/integration/workflows.test.ts test/integration/workflow-races.test.ts`
Expected: FAIL with route not found.

- [ ] **Step 3: Define strict workflow contracts**

```ts
export const workflowColumnSchema = z.discriminatedUnion('type', [
  z.object({ id: key, name, type: z.literal('reference') }).strict(),
  z.object({
    id: key,
    name,
    type: z.literal('generation'),
    prompt: z.string().trim().min(1).max(4000),
    sourceColumnIds: z.array(key).max(2),
    modelId: z.string().min(1),
    resolution: resolutionSchema,
    ratio: ratioSchema,
  }).strict(),
  z.object({
    id: key,
    name,
    type: z.literal('tool'),
    toolId: z.string().min(1),
    toolVersion: z.number().int().positive(),
    sourceColumnIds: z.array(key),
    values: z.record(z.string(), z.string()),
  }).strict(),
]);
```

Define the referenced primitives in the same file:

```ts
const key = z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/);
const name = z.string().trim().min(1).max(80);
const resolutionSchema = z.enum(['0.5K', '1K', '2K', '4K']);
const ratioSchema = z.enum(['21:9', '16:9', '3:2', '5:4', '4:3', '1:1', '4:5', '3:4', '2:3', '9:16']);
```

- [ ] **Step 4: Implement owner-scoped CRUD**

Create assigns server UUID and version `1`. Update uses `updateMany({ where: { id, userId, version } })`, replaces rows within the same transaction, and increments version. A zero update count returns `409 WORKFLOW_VERSION_CONFLICT`. Archive hides the workflow from default lists without deleting runs.

- [ ] **Step 5: Rerun CRUD and race tests**

Run: `cd viviai-server && npm test -- test/integration/workflows.test.ts test/integration/workflow-races.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit workflow CRUD**

```bash
git add viviai-server/src/modules/workflow viviai-server/src/app.module.ts viviai-server/test/integration/workflows.test.ts viviai-server/test/integration/workflow-races.test.ts
git commit -m "feat(server): add versioned workflow CRUD"
```

### Task 3: Compile and quote selected workflow rows

**Files:**
- Create: `viviai-server/src/modules/workflow/workflow-compiler.ts`
- Create: `viviai-server/src/modules/workflow/workflow-quote.service.ts`
- Modify: `viviai-server/src/modules/workflow/workflow.controller.ts`
- Modify: `viviai-server/src/modules/workflow/workflow.module.ts`
- Test: `viviai-server/test/workflow-compiler.test.ts`
- Test: `viviai-server/test/integration/workflow-quotes.test.ts`

**Interfaces:**
- Produces: `compileWorkflowSelection(workflow, rowIds): CompiledWorkflowItem[]`.
- Produces: `POST /api/workflow-run-quotes` returning aggregate and per-item prices/errors.
- Consumes: `ToolCompiler`, `CatalogService.createQuote`, asset ownership, and model capability/pricing.

- [ ] **Step 1: Write failing compiler tests**

Cover stable row order, selected rows only, generation columns, tool columns, empty cells, missing assets, duplicate selections, invalid graphs, exact task counts, and deterministic aggregate input hashes.

- [ ] **Step 2: Run compiler and quote tests**

Run: `cd viviai-server && npm test -- test/workflow-compiler.test.ts test/integration/workflow-quotes.test.ts`
Expected: FAIL because compiler and route are missing.

- [ ] **Step 3: Compile each executable row/column pair**

For generation columns, build normalized `create` or `remix` input from the row's reference cells. For tool columns, call the exact published tool version through `ToolCompiler`. Return field errors keyed by `{ rowId, columnId }`; never silently skip invalid items.

- [ ] **Step 4: Create an aggregate quote transactionally**

Create one normal `GenerationQuote` for each compiled item with workflow origin metadata, then create `WorkflowRunQuote` and its items. Set all expiries to the earliest child quote expiry and compute `totalCredits` as the checked BigInt sum. If any selected item is invalid, return `422` with all collected item errors and create no quotes.

- [ ] **Step 5: Rerun compiler and quote tests**

Run: `cd viviai-server && npm test -- test/workflow-compiler.test.ts test/integration/workflow-quotes.test.ts test/integration/quotes.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit workflow quoting**

```bash
git add viviai-server/src/modules/workflow viviai-server/test/workflow-compiler.test.ts viviai-server/test/integration/workflow-quotes.test.ts
git commit -m "feat(server): quote workflow batches"
```

### Task 4: Submit, cancel, project, and retry batches

**Files:**
- Create: `viviai-server/src/modules/workflow/workflow-run.service.ts`
- Create: `viviai-server/src/modules/workflow/batch-projection.service.ts`
- Modify: `viviai-server/src/modules/workflow/workflow.controller.ts`
- Modify: `viviai-server/src/modules/workflow/workflow.module.ts`
- Modify: `viviai-server/src/modules/generation/generation.service.ts`
- Modify: `viviai-server/src/modules/generation/settlement.service.ts`
- Modify: `viviai-server/src/modules/generation/recovery.service.ts`
- Test: `viviai-server/test/integration/workflow-runs.test.ts`
- Test: `viviai-server/test/integration/workflow-run-races.test.ts`
- Test: `viviai-server/test/integration/workflow-run-settlement.test.ts`

**Interfaces:**
- Produces: run create/detail/list, batch list/detail, cancel, retry quote, and retry submit APIs.
- Produces: `GenerationService.createManyFromQuotes(tx, submissions)`.
- Produces: `BatchProjectionService.reconcile(tx, runId)`.

- [ ] **Step 1: Write failing submission, cancellation, and race tests**

Test atomic credit freeze, insufficient balance rollback, expired/used aggregate quote, duplicate-key replay, concurrent submission, partial success, cancel queued items, running-item cancellation request, provider failure release, terminal status aggregation, and failure-only retry lineage.

- [ ] **Step 2: Run focused run tests**

Run: `cd viviai-server && npm test -- test/integration/workflow-runs.test.ts test/integration/workflow-run-races.test.ts test/integration/workflow-run-settlement.test.ts`
Expected: FAIL because run services are missing.

- [ ] **Step 3: Extract transaction-aware bulk generation creation**

Implement:

```ts
createManyFromQuotes(
  tx: DbTransaction,
  userId: string,
  entries: Array<{
    quoteId: string;
    operation: 'create' | 'remix';
    idempotencyKey: string;
    workflowRunItemId: string;
  }>,
): Promise<GenerationJob[]>;
```

Validate every quote and available balance before writing any job. Then create all jobs/items, freeze credits, consume quotes, and create outbox events inside the caller's transaction.

- [ ] **Step 4: Implement run submission and projection**

Consume one aggregate quote once, snapshot workflow metadata, create run items and linked jobs, then mark the aggregate quote consumed. `reconcile` maps linked job/item states into run counts and derives `queued`, `processing`, `succeeded`, `partial`, `failed`, or `cancelled` without trusting client counters.

- [ ] **Step 5: Implement cancellation and retry lineage**

Cancellation sets `cancelRequested`, releases queued generation items via existing wallet settlement, and lets leased items finish or observe cancellation. Failure retry is two-step: create a new aggregate quote using `retryRunId`, then submit `/workflow-runs/:id/retry-failed` with that quote ID and a new idempotency key; the response is a new run with `retryOfRunId`.

- [ ] **Step 6: Reconcile from settlement and recovery**

After any linked job item becomes terminal, call `BatchProjectionService.reconcile` in the same transaction. Ensure duplicate worker events and recovery passes cannot increment counts twice.

- [ ] **Step 7: Rerun workflow and generation regression tests**

Run: `cd viviai-server && npm test -- test/integration/workflow-runs.test.ts test/integration/workflow-run-races.test.ts test/integration/workflow-run-settlement.test.ts test/integration/jobs.test.ts test/integration/worker.test.ts test/integration/recovery.test.ts test/integration/wallet.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit batch execution backend**

```bash
git add viviai-server/src/modules/workflow viviai-server/src/modules/generation/generation.service.ts viviai-server/src/modules/generation/settlement.service.ts viviai-server/src/modules/generation/recovery.service.ts viviai-server/test/integration/workflow-runs.test.ts viviai-server/test/integration/workflow-run-races.test.ts viviai-server/test/integration/workflow-run-settlement.test.ts
git commit -m "feat(server): execute credit-safe workflow batches"
```

### Task 5: Connect workflow editor and batch history to real APIs

**Files:**
- Modify: `viviai-web/src/types/domain.ts`
- Modify: `viviai-web/src/services/api.ts`
- Modify: `viviai-web/src/services/queryKeys.ts`
- Create: `viviai-web/src/features/workflows/WorkflowQuoteDialog.tsx`
- Create: `viviai-web/src/features/workflows/BatchDetailDialog.tsx`
- Modify: `viviai-web/src/features/workflows/WorkflowsPage.tsx`
- Modify: `viviai-web/src/features/workflows/WorkflowEditorPage.tsx`
- Modify: `viviai-web/src/features/workflows/WorkflowGrid.tsx`
- Modify: `viviai-web/src/features/tasks/TasksPage.tsx`
- Modify: `viviai-web/src/app/routes.tsx`
- Modify: `viviai-web/src/features/workflows/WorkflowEditorPage.test.tsx`
- Create: `viviai-web/src/features/workflows/WorkflowsPage.test.tsx`
- Create: `viviai-web/src/features/workflows/BatchDetailDialog.test.tsx`
- Modify: `viviai-web/src/app/routes.test.tsx`
- Test: `viviai-web/src/services/api.test.ts`

**Interfaces:**
- Consumes: workflow and batch APIs from Tasks 2–4.
- Produces: persisted workflow editor, server quote confirmation, batch progress, cancellation, and failure retry UX.

- [ ] **Step 1: Write failing real-mode workflow tests**

Test create/save/reload, version-conflict presentation, copy/archive, no hard-coded default asset IDs, server quote totals, invalid row/column error mapping, submit idempotency, route availability, progress polling, cancellation, and retry-failed quote confirmation.

- [ ] **Step 2: Run focused frontend tests**

Run: `cd viviai-web && npm test -- src/features/workflows/WorkflowEditorPage.test.tsx src/features/workflows/WorkflowsPage.test.tsx src/features/workflows/BatchDetailDialog.test.tsx src/services/api.test.ts src/app/routes.test.tsx`
Expected: FAIL because real workflow routes are gated and current methods use Mock contracts.

- [ ] **Step 3: Replace Mock workflow methods with explicit commands**

Add exact client methods for create, update with version, copy, archive, quote, run, list/detail batches, cancel, retry quote, and retry submit. Send `Idempotency-Key` only on commands and keep one key for retries of the same user confirmation.

- [ ] **Step 4: Remove hard-coded new-workflow data**

Create a new unsaved workflow with empty asset cells and supported model defaults from `api.listModels`; after first save, replace `/workflows/new` with the server ID. Preserve local dirty state until a save succeeds.

- [ ] **Step 5: Add conflict and quote dialogs**

On `WORKFLOW_VERSION_CONFLICT`, keep the local draft and offer explicit “重新加载服务端版本” and “保留本地内容供复制” actions. Quote dialog displays per-column totals, aggregate credits, balance, expiry, and field errors; it invalidates on any workflow/selection change.

- [ ] **Step 6: Add batch progress to Tasks**

Show each batch alongside generation jobs, poll only non-terminal batches, display counts and charged/released credits, and gate cancel/retry buttons by server-provided state. Retry always obtains and confirms a new quote.

- [ ] **Step 7: Rerun frontend tests and checks**

Run: `cd viviai-web && npm test -- src/features/workflows/WorkflowEditorPage.test.tsx src/features/workflows/WorkflowsPage.test.tsx src/features/workflows/BatchDetailDialog.test.tsx src/services/api.test.ts src/app/routes.test.tsx && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 8: Commit workflow frontend**

```bash
git add viviai-web/src/types/domain.ts viviai-web/src/services viviai-web/src/features/workflows viviai-web/src/features/tasks/TasksPage.tsx viviai-web/src/app/routes.tsx viviai-web/src/app/routes.test.tsx
git commit -m "feat(web): connect workflow batch execution"
```

### Task 6: Enable authorized batch operations in the admin console

**Files:**
- Create: `viviai-server/src/modules/admin/workflows/workflow-admin.controller.ts`
- Create: `viviai-server/src/modules/admin/workflows/workflow-admin.service.ts`
- Modify: `viviai-server/src/modules/admin/admin.module.ts`
- Modify: `viviai-server/src/modules/admin/permission-catalog.ts`
- Modify: `viviai-admin/src/ResourcePage.tsx`
- Create: `viviai-admin/src/batches/BatchOperations.tsx`
- Create: `viviai-admin/src/batches/BatchOperations.test.tsx`
- Test: `viviai-server/test/integration/admin-batches.test.ts`

**Interfaces:**
- Produces: paginated admin workflow/batch reads plus permission-gated batch cancel and system-failure retry-quote commands.
- Consumes: `WorkflowRunService`, command receipts, audit, and sensitive-access policy.

- [ ] **Step 1: Write failing backend and frontend admin tests**

Assert redacted workflow/batch lists, read/manage permission separation, required reason, only queued cancellation, only system-failure retry eligibility, idempotency, audit sanitization, and hidden buttons without permission.

- [ ] **Step 2: Run focused tests**

Run: `cd viviai-server && npm test -- test/integration/admin-batches.test.ts`
Expected: FAIL because admin commands are absent.
Run: `cd viviai-admin && npm test -- src/batches/BatchOperations.test.tsx`
Expected: FAIL because operations UI is absent.

- [ ] **Step 3: Implement admin commands through workflow services**

Expose `/admin/workflows` and `/admin/batches` only after their Prisma models exist; list DTOs omit cell contents, prompts, and reference IDs. Do not duplicate cancellation or retry logic. Require `batches.manage`, a 5–500 character operational reason, current run state, and an idempotency key. Return action availability with denial reasons for the UI.

- [ ] **Step 4: Add operation controls to batch detail**

Add the `任务运营` navigation group with `工作流` and `批量任务`. Render cancel/retry only when both permission and server availability allow them. Require typed reason and confirmation. Refresh actor permissions and batch state after `403` or `409`; never show customer prompt/reference content in the normal detail page.

- [ ] **Step 5: Rerun admin backend/frontend tests**

Run: `cd viviai-server && npm test -- test/integration/admin-batches.test.ts`
Expected: PASS.
Run: `cd viviai-admin && npm test -- src/batches/BatchOperations.test.tsx && npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 6: Commit admin batch operations**

```bash
git add viviai-server/src/modules/admin/workflows viviai-server/src/modules/admin/admin.module.ts viviai-server/src/modules/admin/permission-catalog.ts viviai-server/test/integration/admin-batches.test.ts viviai-admin/src/ResourcePage.tsx viviai-admin/src/batches
git commit -m "feat(admin): operate workflow batches safely"
```

### Task 7: Project cross-module operational alerts

**Files:**
- Modify: `viviai-server/src/modules/admin/query.service.ts`
- Modify: `viviai-server/src/modules/admin/presentation.ts`
- Test: `viviai-server/test/integration/admin-operational-alerts.test.ts`

**Interfaces:**
- Produces: durable `AdminAlert` rows for content publication failures, missing terminal notifications, anomalous redemption counts, and high-failure batches.
- Consumes: `AdminAuditEvent`, `Notification`, `RedemptionClaim`, `RedemptionCode`, `WorkflowRun`, and existing alert projection locking.

- [ ] **Step 1: Write failing projection tests**

Create each anomalous database state, call `/api/admin/alerts`, and assert one service-category alert with a stable source key and no prompt, reference, code, or secret content. Correct the state, refresh alerts, and assert the corresponding alert becomes resolved.

- [ ] **Step 2: Run the operational alert tests**

Run: `cd viviai-server && npm test -- test/integration/admin-operational-alerts.test.ts`
Expected: FAIL because the projection only recognizes existing provider and reservation alerts.

- [ ] **Step 3: Extend the existing locked alert projection**

Within `refreshAlerts`, add bounded `INSERT ... SELECT ... ON CONFLICT` projections using these stable keys and rules:

```text
content-publish:<auditEventId>   failed content publish audit outcome
notification-missing:<jobId>    terminal job older than 10 minutes without generation-terminal notification
redemption-count:<codeId>       RedemptionCode.usedCount differs from successful claim count
batch-failure:<runId>            terminal run with at least 4 items and failed items >= 50%
```

Use only resource IDs in alerts. Rely on the existing projection timestamp/resolution pass so healed conditions resolve automatically.

- [ ] **Step 4: Present localized, non-sensitive alert kinds**

Add Chinese labels for the four alert kinds in `presentation.ts`; keep category `service` so existing `alerts.service.read` permissions apply. Treat `AdminAuditEvent` and `AdminAlert` as durable structured operational records because the Nest application logger is intentionally disabled.

- [ ] **Step 5: Rerun alert and admin query regression tests**

Run: `cd viviai-server && npm test -- test/integration/admin-operational-alerts.test.ts test/integration/admin-queries.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit operational alert coverage**

```bash
git add viviai-server/src/modules/admin/query.service.ts viviai-server/src/modules/admin/presentation.ts viviai-server/test/integration/admin-operational-alerts.test.ts
git commit -m "feat(admin-api): project product operational alerts"
```

### Task 8: Verify the complete non-payment product flow

**Files:**
- Create: `viviai-server/test/e2e/workflow-batch.test.ts`
- Create: `viviai-web/e2e/non-payment-product.spec.ts`
- Modify only files owned by the four plans when verification exposes a defect.

**Interfaces:**
- Verifies: all non-payment user routes, content operations, tool runs, workflows, batches, notifications, invites, redemption, model constraints, and payment non-regression.

- [ ] **Step 1: Write the backend workflow E2E test**

Create a funded user, upload references, save a multi-row workflow, quote and submit it, simulate one success and one provider failure, assert partial status and exact consumed/released credits, quote and submit failed-only retry, and assert immutable original history.

- [ ] **Step 2: Run the backend E2E test**

Run: `cd viviai-server && npm test -- test/e2e/workflow-batch.test.ts`
Expected: PASS.

- [ ] **Step 3: Write the browser E2E path**

The Playwright test must log in, open every non-payment menu, update profile/avatar, read a notification, view invitations, redeem a seeded one-use code, like inspiration, favorite a template, run a tool, create/save/reload a workflow, submit a batch, and verify persisted terminal state after reload. Stub only external model-provider transport; use the real local API and database.

- [ ] **Step 4: Run the browser E2E test**

Run: `cd viviai-web && npm run test:e2e -- e2e/non-payment-product.spec.ts`
Expected: PASS.

- [ ] **Step 5: Run all project verification commands**

Run: `cd viviai-server && npm test && npm run typecheck && npm run build`
Expected: PASS.
Run: `cd viviai-web && npm test && npm run lint && npm run build`
Expected: PASS.
Run: `cd viviai-admin && npm test && npm run typecheck && npm run build && npm run smoke && npm run smoke:team && npm run smoke:pricing && npm run smoke:content`
Expected: PASS.

- [ ] **Step 6: Confirm payment files are unchanged by this plan series**

Run: `git diff f975353 -- viviai-server/src/modules/billing viviai-web/src/features/billing`
Expected: no changes unless a separately approved regression-test-only edit exists.

- [ ] **Step 7: Commit final E2E coverage**

```bash
git add viviai-server/test/e2e/workflow-batch.test.ts viviai-web/e2e/non-payment-product.spec.ts
git commit -m "test: cover complete non-payment product flow"
```
