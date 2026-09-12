# AI Tool Execution API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute published AI tools through server-side input compilation, authoritative model pricing, the existing generation queue, and the existing wallet settlement flow.

**Architecture:** A tool quote freezes the tool version, validated field values, asset snapshots, compiled generation input, model configuration, and credit price. Submission consumes that quote exactly once and creates an ordinary generation job with tool-origin metadata, so providers and workers need no separate tool execution path.

**Tech Stack:** TypeScript, NestJS, Prisma/PostgreSQL, Zod, Vitest, React, TanStack Query, existing generation/catalog/wallet/provider services.

**Spec:** `docs/superpowers/specs/2026-09-12-viviai-non-payment-full-api-design.md`

## Global Constraints

- Complete account-engagement and content-operations plans first.
- The client never submits a price and cannot insert undeclared prompt variables or model parameters.
- The compiled provider input remains `source: create | remix`; tool/workflow identity is separate origin metadata.
- Tool submission requires a non-expired quote and an `Idempotency-Key` matching the existing 8–128 character policy.
- Every supported resolution/ratio must come from the current model capability catalog and active model credit pricing.
- A tool edit or unpublish after quote creation invalidates submission.
- Do not change provider adapter behavior or payment behavior.

---

### Task 1: Persist generation origin snapshots

**Files:**
- Modify: `viviai-server/prisma/schema.prisma`
- Create: `viviai-server/prisma/migrations/20260912030000_generation_origins/migration.sql`
- Modify: `viviai-server/src/modules/generation/job-serializer.ts`
- Test: `viviai-server/test/integration/generation-origin.test.ts`

**Interfaces:**
- Produces: optional `originType`, `originId`, `originVersion`, and `originSnapshot` on `GenerationQuote` and `GenerationJob`.
- Produces: serialized `toolId` and `toolVersion` without exposing field values or prompt snapshots in list DTOs.

- [ ] **Step 1: Write a failing origin serialization test**

```ts
expect(jobDto(jobWithToolOrigin)).toMatchObject({
  toolId: 'product-background',
  toolVersion: 3,
});
expect(jobDto(jobWithToolOrigin)).not.toHaveProperty('originSnapshot');
```

- [ ] **Step 2: Run the focused test**

Run: `cd viviai-server && npm test -- test/integration/generation-origin.test.ts`
Expected: FAIL because origin fields are absent.

- [ ] **Step 3: Add nullable origin columns and constraints**

Use string external IDs rather than foreign keys so archived definitions and historical tasks remain readable. Add a check requiring all origin fields together when `origin_type` is not null, and allow only `tool` or `workflow` for this migration.

- [ ] **Step 4: Update job serialization**

Project only safe identity fields:

```ts
const origin =
  job.originType === 'tool'
    ? { toolId: job.originId!, toolVersion: job.originVersion! }
    : job.originType === 'workflow'
      ? { workflowId: job.originId! }
      : {};
```

- [ ] **Step 5: Generate Prisma and rerun the test**

Run: `cd viviai-server && npm run prisma:generate && npm test -- test/integration/generation-origin.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit origin persistence**

```bash
git add viviai-server/prisma/schema.prisma viviai-server/prisma/migrations/20260912030000_generation_origins viviai-server/src/modules/generation/job-serializer.ts viviai-server/test/integration/generation-origin.test.ts
git commit -m "feat(server): persist generation origins"
```

### Task 2: Build and test the strict tool compiler

**Files:**
- Create: `viviai-server/src/modules/tool-execution/tool-input.ts`
- Create: `viviai-server/src/modules/tool-execution/tool-compiler.ts`
- Test: `viviai-server/test/tool-compiler.test.ts`

**Interfaces:**
- Produces: `parseToolQuoteInput(raw): ToolQuoteInput`.
- Produces: `compileTool(definition, input, assets): CompiledToolRun`.
- Consumes: shared content-contract schemas and `normalizeInput`.

- [ ] **Step 1: Write failing compiler tests**

Cover required text/select/radio fields, unknown fields, invalid option values, max-assets enforcement, prompt escaping, missing placeholders, deterministic compilation, create-vs-remix selection, and subject/reference uniqueness.

- [ ] **Step 2: Run compiler tests**

Run: `cd viviai-server && npm test -- test/tool-compiler.test.ts`
Expected: FAIL because compiler modules do not exist.

- [ ] **Step 3: Define strict request and compiled types**

```ts
export interface ToolQuoteInput {
  toolId: string;
  toolVersion: number;
  assetIds: string[];
  values: Record<string, string>;
  modelId: string;
  resolution: '0.5K' | '1K' | '2K' | '4K';
  ratio: string;
  count: 1 | 2 | 3 | 4;
}

export interface CompiledToolRun {
  generationInput: GenerationInput;
  originSnapshot: {
    toolId: string;
    toolVersion: number;
    valueDigest: string;
    compiledPrompt: string;
  };
}
```

- [ ] **Step 4: Implement literal placeholder substitution**

Only replace `{{field_id}}` tokens declared by the tool Schema. Normalize whitespace, enforce the 4,000-character generation prompt limit after compilation, and never evaluate JavaScript or nested template expressions.

- [ ] **Step 5: Run compiler tests and typecheck**

Run: `cd viviai-server && npm test -- test/tool-compiler.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit compiler**

```bash
git add viviai-server/src/modules/tool-execution/tool-input.ts viviai-server/src/modules/tool-execution/tool-compiler.ts viviai-server/test/tool-compiler.test.ts
git commit -m "feat(server): compile strict AI tool inputs"
```

### Task 3: Add authoritative tool quotes and idempotent submission

**Files:**
- Create: `viviai-server/src/modules/tool-execution/tool-execution.module.ts`
- Create: `viviai-server/src/modules/tool-execution/tool-execution.controller.ts`
- Create: `viviai-server/src/modules/tool-execution/tool-execution.service.ts`
- Modify: `viviai-server/src/modules/catalog/catalog.service.ts`
- Modify: `viviai-server/src/modules/generation/generation.service.ts`
- Modify: `viviai-server/src/app.module.ts`
- Test: `viviai-server/test/integration/tool-execution.test.ts`
- Test: `viviai-server/test/integration/tool-execution-races.test.ts`

**Interfaces:**
- Produces: `POST /api/tool-run-quotes` and `POST /api/tool-runs`.
- Produces: `CatalogService.createQuote(userId, input, origin)` shared by direct and derived generation flows.
- Produces: `GenerationService.createFromQuote(userId, quoteId, idempotencyKey, expectedOrigin)`.

- [ ] **Step 1: Write failing API and race tests**

Test valid quote/submit, wrong user, expired quote, used quote, changed tool version, offline tool, deleted asset, unsupported model spec, missing model price, insufficient balance, duplicate-key replay, key/payload conflict, and two concurrent submissions of one quote.

- [ ] **Step 2: Run focused integration tests**

Run: `cd viviai-server && npm test -- test/integration/tool-execution.test.ts test/integration/tool-execution-races.test.ts`
Expected: FAIL with route not found.

- [ ] **Step 3: Generalize quote creation without changing public generation behavior**

Add an internal origin parameter:

```ts
type QuoteOrigin = {
  type: 'tool' | 'workflow';
  id: string;
  version: number;
  snapshot: Prisma.InputJsonValue;
};

createQuote(userId: string, rawInput: unknown, origin?: QuoteOrigin): Promise<GenerationQuoteDto>;
```

Continue hashing normalized input plus asset snapshots. Include origin identity and snapshot digest in the quote hash.

- [ ] **Step 4: Implement tool quote creation**

Load the exact published tool version, resolve all assets by `userId`, compile input, call `CatalogService.createQuote`, and return display fields plus `quoteId`, `unitCredits`, `totalCredits`, and expiry. Do not return `compiledPrompt` separately.

- [ ] **Step 5: Refactor generation submission around `createFromQuote`**

Keep direct `/generation-tasks` and `/remix-tasks` behavior unchanged. Tool submission sends `{ quoteId }`; server validates `originType/toolId/toolVersion`, consumes the quote, freezes credits, creates origin metadata and outbox events in one transaction, then returns the standard job DTO.

- [ ] **Step 6: Rerun tool, direct generation, quote, and wallet tests**

Run: `cd viviai-server && npm test -- test/integration/tool-execution.test.ts test/integration/tool-execution-races.test.ts test/integration/quotes.test.ts test/integration/jobs.test.ts test/integration/wallet.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit tool execution backend**

```bash
git add viviai-server/src/modules/tool-execution viviai-server/src/modules/catalog/catalog.service.ts viviai-server/src/modules/generation/generation.service.ts viviai-server/src/app.module.ts viviai-server/test/integration/tool-execution.test.ts viviai-server/test/integration/tool-execution-races.test.ts
git commit -m "feat(server): execute tools through generation jobs"
```

### Task 4: Emit one terminal task notification per job

**Files:**
- Modify: `viviai-server/prisma/schema.prisma`
- Create: `viviai-server/prisma/migrations/20260912031000_notification_event_keys/migration.sql`
- Modify: `viviai-server/src/modules/generation/settlement.service.ts`
- Modify: `viviai-server/src/modules/engagement/notification.service.ts`
- Modify: `viviai-server/src/modules/generation/generation.module.ts`
- Test: `viviai-server/test/integration/worker-notifications.test.ts`

**Interfaces:**
- Produces: `NotificationService.createOnce(eventKey, notification)`.
- Consumes: terminal generation-item settlement and job aggregate state.

- [ ] **Step 1: Write a failing worker notification test**

Process duplicate success/failure delivery events and assert exactly one terminal notification per job, an internal `/tasks` href, no provider payload, and no notification while sibling items remain non-terminal.

- [ ] **Step 2: Run the test**

Run: `cd viviai-server && npm test -- test/integration/worker-notifications.test.ts`
Expected: FAIL because settlement emits no notification.

- [ ] **Step 3: Add a durable notification event key**

Add a nullable unique `eventKey` to `Notification` in a small additive migration named `20260912031000_notification_event_keys`. Use `generation-terminal:<jobId>` and `createMany({ skipDuplicates: true })` or an equivalent unique upsert.

- [ ] **Step 4: Emit after the final item settles**

Inside the settlement transaction, recompute job aggregate state. Create a `task` notification only when all items are terminal, with a generic success/partial/failure message and `action: { href: '/tasks', jobId }`.

- [ ] **Step 5: Rerun worker and recovery tests**

Run: `cd viviai-server && npm test -- test/integration/worker-notifications.test.ts test/integration/worker.test.ts test/integration/recovery.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit terminal notifications**

```bash
git add viviai-server/prisma/schema.prisma viviai-server/prisma/migrations/20260912031000_notification_event_keys viviai-server/src/modules/generation/settlement.service.ts viviai-server/src/modules/engagement/notification.service.ts viviai-server/src/modules/generation/generation.module.ts viviai-server/test/integration/worker-notifications.test.ts
git commit -m "feat(server): notify terminal generation jobs"
```

### Task 5: Add quote confirmation to the user tool page

**Files:**
- Modify: `viviai-web/src/types/domain.ts`
- Modify: `viviai-web/src/services/api.ts`
- Modify: `viviai-web/src/services/queryKeys.ts`
- Create: `viviai-web/src/features/tools/ToolQuoteDialog.tsx`
- Modify: `viviai-web/src/features/tools/ToolRunPage.tsx`
- Modify: `viviai-web/src/features/tools/ToolsPage.tsx`
- Modify: `viviai-web/src/app/routes.tsx`
- Modify: `viviai-web/src/features/tools/ToolRunPage.test.tsx`
- Test: `viviai-web/src/services/api.test.ts`
- Test: `viviai-web/src/app/routes.test.tsx`

**Interfaces:**
- Consumes: tool catalog and execution APIs.
- Produces: `ToolRunQuote`, `api.createToolRunQuote`, and quote-backed `api.runTool`.

- [ ] **Step 1: Write failing real-mode tool tests**

Assert route availability, exact quote payload, server total display, expiration handling, quote refresh after form change, insufficient-credit error, submit idempotency key, task cache insertion, and no client-side price authority.

- [ ] **Step 2: Run focused frontend tests**

Run: `cd viviai-web && npm test -- src/features/tools/ToolRunPage.test.tsx src/services/api.test.ts src/app/routes.test.tsx`
Expected: FAIL because real routes are gated and tool submission has no quote.

- [ ] **Step 3: Define quote-backed API methods**

```ts
createToolRunQuote(input: ToolQuoteInput): Promise<ToolRunQuote>
runTool(quoteId: string, idempotencyKey: string): Promise<GenerationTask>
```

Generate the idempotency key once per confirmation attempt with `crypto.randomUUID()` and retain it across network retries of the same attempt.

- [ ] **Step 4: Implement the confirmation dialog**

Display tool name/version, model, resolution, ratio, count, unit credits, total credits, current available balance, and expiry. Disable confirmation after expiry or form changes and provide a “重新报价” action.

- [ ] **Step 5: Remove tool route gates and wire task polling**

Use normal task list polling and `GenerationCard`. Keep the selected values in local state; never render the server's compiled prompt snapshot. Show query loading/empty/error states.

- [ ] **Step 6: Rerun frontend tests and checks**

Run: `cd viviai-web && npm test -- src/features/tools/ToolRunPage.test.tsx src/services/api.test.ts src/app/routes.test.tsx && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 7: Commit tool frontend**

```bash
git add viviai-web/src/types/domain.ts viviai-web/src/services viviai-web/src/features/tools viviai-web/src/app/routes.tsx viviai-web/src/app/routes.test.tsx
git commit -m "feat(web): run AI tools with server quotes"
```

### Task 6: Verify tool execution end to end

**Files:**
- Create: `viviai-server/test/e2e/tool-execution.test.ts`
- Modify only owned files when the end-to-end test identifies a defect.

**Interfaces:**
- Verifies: admin-published tool to user quote, wallet freeze, worker execution, settlement, asset, and notification.

- [ ] **Step 1: Write the end-to-end test**

Create/publish a tool through the admin service fixture, create a user and funded credit lot, upload an asset, quote/submit the tool, drain the simulated worker, then assert one result asset, settled credits, tool origin fields, and one terminal notification.

- [ ] **Step 2: Run the E2E test**

Run: `cd viviai-server && npm test -- test/e2e/tool-execution.test.ts`
Expected: PASS after Tasks 1–5; any failure identifies an integration defect to fix before continuing.

- [ ] **Step 3: Run full backend verification**

Run: `cd viviai-server && npm test && npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 4: Run full user frontend verification**

Run: `cd viviai-web && npm test && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit the E2E test and any narrowly scoped fixes**

```bash
git add viviai-server/test/e2e/tool-execution.test.ts
git commit -m "test: cover quoted AI tool execution"
```
