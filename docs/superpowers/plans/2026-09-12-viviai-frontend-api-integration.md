# VIVIAI Frontend API Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the VIVIAI web frontend to the existing NestJS API for authenticated creation, remix, uploads, tasks, assets, models and server-side quotes while preserving Mock mode.

**Architecture:** Keep `src/services/api.ts` as the only page-facing API boundary. Add a configurable transport that uses the real API when `VITE_API_MODE=real`, including cookies, envelope parsing and binary asset URLs; otherwise start MSW as today. Make quote-then-submit and DTO normalization explicit in the service so pages keep simple React Query mutations.

**Tech Stack:** React 19, TypeScript, React Query, Zustand, MSW/Vitest, NestJS HTTP contract.

**Spec:** `docs/superpowers/specs/2026-09-12-viviai-frontend-api-integration.md`

## Global Constraints

- The real backend is the source of truth for model specs, prices, task status and asset ownership.
- Every real task mutation sends `credentials: include`; creation and retry include a valid `Idempotency-Key`.
- Real task submission is always `generation-quotes` followed by `generation-tasks` or `remix-tasks`.
- Do not send requests to Mock-only routes in real mode.
- Preserve existing dirty user changes and keep Mock tests isolated.
- Use `apply_patch` for edits and run a focused failing test before implementation for each behavior.

### Task 1: Add transport configuration and contract tests

**Files:**
- Create: `viviai-web/src/services/api.test.ts`
- Modify: `viviai-web/src/services/api.ts`
- Modify: `viviai-web/src/app/AppProviders.tsx`
- Modify: `viviai-web/vite.config.ts` (only if a local proxy is needed)

**Interfaces:**
- Produces `apiConfig: { mode: 'mock' | 'real'; baseUrl: string }`, `isRealApi()`, and request behavior used by every API method.

- [ ] **Step 1: Write the failing test**

  Stub `fetch`, set `VITE_API_MODE=real` through the test environment, call `api.getMe()` and assert the request URL, `credentials: 'include'`, JSON content type and envelope result. Add a test that an error envelope becomes `ApiError` with its code/status.

- [ ] **Step 2: Run the focused test**

  Run `cd viviai-web && npx vitest run src/services/api.test.ts`.
  Expected: FAIL because the current client uses the window origin and omits credentials/configuration.

- [ ] **Step 3: Implement the minimal transport**

  Read `import.meta.env.VITE_API_MODE`/`VITE_API_BASE_URL` safely, default to Mock mode and same-origin `/api`; resolve real URLs without double `/api`; use `credentials: 'include'`, an abort timeout, JSON content-type only for JSON bodies, and robust JSON/error parsing. In `AppProviders`, start MSW only when `isRealApi()` is false and mark providers ready immediately in real mode.

- [ ] **Step 4: Run the focused test**

  Run `cd viviai-web && npx vitest run src/services/api.test.ts`.
  Expected: PASS.

- [ ] **Step 5: Commit**

  Commit `feat: add configurable real api transport` with only transport/provider/test files.

### Task 2: Align models, auth and asset DTOs with the backend

**Files:**
- Create: `viviai-web/src/services/normalizers.ts`
- Create: `viviai-web/src/services/normalizers.test.ts`
- Modify: `viviai-web/src/types/domain.ts`
- Modify: `viviai-web/src/services/api.ts`
- Modify: `viviai-web/src/features/auth/AuthPage.tsx`
- Modify: `viviai-web/src/features/assets/AssetCard.tsx`

**Interfaces:**
- Produces `normalizeModelDto`, `normalizeTaskDto`, `normalizeAssetDto` and `assetContentUrl(id)`.

- [ ] **Step 1: Write the failing tests**

  Feed a backend model with `specs` and a task with `stage/items` to the normalizers; assert `0.5K`, exact specs and derived private asset URLs. Assert `api.sendCode(email, 'reset-password')` sends the purpose, and `api.uploadRemixReference(file)` sends only multipart `file`.

- [ ] **Step 2: Run focused tests**

  Run `cd viviai-web && npx vitest run src/services/normalizers.test.ts src/services/api.test.ts`.
  Expected: FAIL because the domain types and methods do not match the backend DTOs.

- [ ] **Step 3: Implement DTO alignment**

  Add `0.5K` and backend-compatible optional fields. Normalize backend source `create` to UI source `generation`, derive `imageUrl`/`thumbnailUrl` from content URLs when the backend does not return URLs, and preserve Mock DTO compatibility. Update auth code to send `purpose`, enforce 12-character real password validation while retaining the Mock demo hint, and update download extension to PNG.

- [ ] **Step 4: Run focused tests**

  Run the same Vitest command; expected PASS.

- [ ] **Step 5: Commit**

  Commit `feat: normalize backend catalog task and asset dto`.

### Task 3: Implement server-authoritative quote and idempotent task flow

**Files:**
- Create: `viviai-web/src/services/generationFlow.ts`
- Create: `viviai-web/src/services/generationFlow.test.ts`
- Modify: `viviai-web/src/services/api.ts`
- Modify: `viviai-web/src/features/generation/CreatePage.tsx`
- Modify: `viviai-web/src/features/remix/RemixWorkbench.tsx`
- Modify: `viviai-web/src/features/generation/CreditEstimator.tsx`
- Modify: `viviai-web/src/features/generation/ModelParameterPanel.tsx`

**Interfaces:**
- Produces `createGeneration(input): Promise<{ task: GenerationTask; quote: GenerationQuote }>` and `createRemix(input): Promise<{ task: GenerationTask; quote: GenerationQuote }>`; each method creates a stable key per user submit and sends `{ quoteId, input }`.

- [ ] **Step 1: Write failing flow tests**

  Mock `fetch` with quote and task envelopes. Assert two calls in order, `source: 'create'` for generation, `source: 'remix'` plus reference/subject IDs for remix, exact `quoteId`, `Idempotency-Key`, and returned `totalCredits` used by the UI flow. Add a 409 quote-expired assertion.

- [ ] **Step 2: Run focused test**

  Run `cd viviai-web && npx vitest run src/services/generationFlow.test.ts`.
  Expected: FAIL because current pages call task endpoints directly without quotes or keys.

- [ ] **Step 3: Implement flow and UI wiring**

  Add quote types and API methods. Convert generation drafts to backend input (`format: 'png'`, `quality: 'standard'`, `source: 'create'`), use model specs for resolution/ratio options, display the latest quote total instead of local pricing when available, and replace direct create/retry calls with flow helpers. Generate keys matching `/^[A-Za-z0-9._:-]{8,128}$/` and do not retry a failed create automatically.

- [ ] **Step 4: Run focused and existing generation/remix tests**

  Run `cd viviai-web && npx vitest run src/services/generationFlow.test.ts src/features/generation/CreatePage.test.tsx src/features/remix/RemixWorkbench.test.tsx`.
  Expected: PASS in Mock mode.

- [ ] **Step 5: Commit**

  Commit `feat: submit generation through backend quotes`.

### Task 4: Wire authenticated uploads, assets and task polling

**Files:**
- Modify: `viviai-web/src/features/remix/ReferenceImageInput.tsx`
- Modify: `viviai-web/src/features/assets/AssetsPage.tsx`
- Modify: `viviai-web/src/features/assets/AssetPreviewDialog.tsx`
- Modify: `viviai-web/src/features/generation/useGenerationTasks.ts`
- Modify: `viviai-web/src/features/generation/GenerationCard.tsx`
- Modify: `viviai-web/src/services/api.ts`

**Interfaces:**
- Consumes `uploadRemixReference`, normalized assets/tasks and the flow helpers from Tasks 1–3.

- [ ] **Step 1: Write failing integration tests**

  Assert an uploaded reference stores the server UUID (not `upload-*`), asset preview/download use `/api/assets/:id/content`, and active real tasks refetch detail/list until terminal state.

- [ ] **Step 2: Run focused test**

  Run `cd viviai-web && npx vitest run src/features/remix/ReferenceImageInput.test.tsx src/features/assets/AssetsPage.test.tsx src/features/generation/useGenerationTasks.test.tsx`.
  Expected: FAIL because current upload sends client dimensions and active task polling only lists Mock tasks.

- [ ] **Step 3: Implement upload/assets/polling behavior**

  Remove width/height fields from real multipart requests while preserving the Mock handler compatibility through transport mode. Normalize asset URLs and use PNG filenames. Add detail polling for active task IDs and invalidate me/assets after terminal results; keep existing cancel and restore mutations.

- [ ] **Step 4: Run focused and full web tests**

  Run `cd viviai-web && npm test`.
  Expected: PASS.

- [ ] **Step 5: Commit**

  Commit `feat: connect frontend uploads assets and task polling`.

### Task 5: Documentation and verification

**Files:**
- Modify: `viviai-web/README.md`
- Create: `viviai-web/.env.example`
- Modify: `viviai-web/src/mocks/handlers.test.ts` only if transport changes require an explicit mode reset.

- [ ] **Step 1: Write a configuration test**

  Assert the default mode remains Mock when no env is present and real mode is selected only by `VITE_API_MODE=real`.

- [ ] **Step 2: Run verification**

  Run `cd viviai-web && npx tsc --noEmit && npm run build && npm run lint && npm test`.
  Expected: all commands pass.

- [ ] **Step 3: Document local real API setup**

  Add `VITE_API_MODE`, `VITE_API_BASE_URL`, `CORS_ORIGINS`, Cookie behavior, quote/task sequencing, and the list of Mock-only pages to README. Do not add secrets or API keys.

- [ ] **Step 4: Commit**

  Commit `docs: document real frontend api mode`.
