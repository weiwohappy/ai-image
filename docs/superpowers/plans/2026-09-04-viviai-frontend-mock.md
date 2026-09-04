# VIVIAI Frontend Mock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a complete multi-route VIVIAI frontend whose authentication, image generation, viral remix, assets, tools, workflows, billing, and account flows run against replaceable Mock APIs.

**Architecture:** Scaffold the official Sites Vinext project in `viviai-web/`, then mount a client-side `HashRouter` so deployed static routes match the source product's `#/` behavior. Pages consume typed services through TanStack Query; MSW owns the temporary backend state and Zustand owns only cross-route UI state and drafts.

**Tech Stack:** React, TypeScript, Vite/Vinext, React Router, TanStack Query, Zustand, MSW, Tailwind CSS, Shadcn UI, Vitest, Testing Library, Playwright

**Spec:** `docs/superpowers/specs/2026-09-04-viviai-frontend-mock-design.md`

## Global Constraints

- Site source lives under `viviai-web/`; existing PRD, finance analysis, and reference artwork at the workspace root remain untouched.
- Use the official Sites initializer pinned in the environment instructions and include the `shadcn` add-on.
- The app is frontend-only: no real model call, payment, email, object storage, or production authentication.
- Every page reads data through `src/services/api.ts`; components must never import `src/mocks/db.ts`.
- Use HashRouter routes so direct static hosting and the source product's `#/` navigation both work.
- Use simplified Chinese UI copy and keep the brand name consistently as `VIVIAI`.
- Default visual direction is Midnight Studio: `#11120f` canvas, `#191a16` sidebar, `#1d1e1a` surfaces, `#d8ff52` primary action.
- Acid green is reserved for primary actions, selection, active progress, and key values.
- Regular UI text is at least 14px and body content is at least 16px.
- All icon-only controls require an accessible name and all dialogs must trap focus.
- Do not add API Key management, real social sharing, video generation, team management, or an operations console.

---

### Task 1: Scaffold the Site and establish the test harness

**Files:**
- Create: `viviai-web/` via the official Sites initializer
- Modify: `viviai-web/package.json`
- Modify: `viviai-web/vitest.config.ts`
- Create: `viviai-web/playwright.config.ts`
- Create: `viviai-web/src/test/setup.ts`
- Test: `viviai-web/src/test/smoke.test.tsx`

**Interfaces:**
- Consumes: official Sites Vinext scaffold with Shadcn primitives
- Produces: `npm run test`, `npm run test:e2e`, and `npm run build`

- [ ] **Step 1: Scaffold into the empty project directory**

Run:

```bash
npm create --yes @openai/sites@0.3.0 viviai-web -- --yes --add-ons shadcn --install
```

Expected: `viviai-web/package.json`, `app/page.tsx`, `app/layout.tsx`, `app/globals.css`, `components/ui/`, and `.openai/hosting.json` exist.

- [ ] **Step 2: Install the approved client and test dependencies**

Run:

```bash
npm install react-router-dom @tanstack/react-query zustand msw
npm install -D vitest @vitest/coverage-v8 jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event @playwright/test
```

Expected: the lockfile records each dependency without changing package manager.

- [ ] **Step 3: Write the failing smoke test**

```tsx
import { render, screen } from "@testing-library/react";
import { App } from "@/src/app/App";

it("renders the VIVIAI product shell", () => {
  render(<App />);
  expect(screen.getByRole("link", { name: "图片生成" })).toBeInTheDocument();
});
```

- [ ] **Step 4: Run the smoke test and verify the missing application fails**

Run: `npm run test -- src/test/smoke.test.tsx`

Expected: FAIL because `@/src/app/App` does not exist.

- [ ] **Step 5: Add test configuration and the smallest application export**

```tsx
export function App() {
  return <a href="#/create">图片生成</a>;
}
```

Configure Vitest for `jsdom`, load `@testing-library/jest-dom/vitest`, and add scripts `test`, `test:coverage`, and `test:e2e`.

- [ ] **Step 6: Run tests and build**

Run: `npm run test -- src/test/smoke.test.tsx && npm run build`

Expected: PASS and a successful production build.

- [ ] **Step 7: Commit the foundation**

```bash
git add viviai-web
git commit -m "chore: scaffold VIVIAI frontend"
```

---

### Task 2: Define domain contracts, pricing rules, and visual tokens

**Files:**
- Create: `viviai-web/src/types/domain.ts`
- Create: `viviai-web/src/lib/pricing.ts`
- Test: `viviai-web/src/lib/pricing.test.ts`
- Modify: `viviai-web/app/globals.css`
- Modify: `viviai-web/app/layout.tsx`

**Interfaces:**
- Consumes: no business interfaces
- Produces: `ModelConfig`, `GenerationTask`, `Asset`, `ViralTemplate`, `Workflow`, `Plan`, `ApiError`, `estimateCredits(input)`

- [ ] **Step 1: Write failing pricing tests**

```ts
expect(estimateCredits({ modelId: "nano-banana-2", resolution: "4K", count: 4 })).toBe(24);
expect(estimateCredits({ modelId: "g-image-2", resolution: "2K", quality: "high", count: 2 })).toBe(18);
expect(() => estimateCredits({ modelId: "nano-banana", resolution: "4K", count: 1 })).toThrow("PARAMETER_UNSUPPORTED");
```

- [ ] **Step 2: Run the test and verify failure**

Run: `npm run test -- src/lib/pricing.test.ts`

Expected: FAIL because `estimateCredits` is missing.

- [ ] **Step 3: Implement exact domain unions and the pricing function**

```ts
export type TaskStatus = "queued" | "processing" | "succeeded" | "partial" | "failed" | "cancelled";
export type RemixStrength = "similar" | "balanced" | "creative";
export type Resolution = "1K" | "2K" | "4K";
export interface EstimateCreditsInput {
  modelId: string;
  resolution: Resolution;
  quality?: "low" | "medium" | "high";
  count: 1 | 2 | 3 | 4;
}
```

Use a typed matrix matching the PRD and throw `PARAMETER_UNSUPPORTED` for missing combinations.

- [ ] **Step 4: Apply product metadata and design tokens**

Set the document title to `VIVIAI — AI 图片创作工作台` and define CSS variables for canvas, sidebar, surface, elevated surface, border, primary, success, danger, primary text, muted text, three radii, and the 150/220ms motion durations.

- [ ] **Step 5: Run tests and build**

Run: `npm run test -- src/lib/pricing.test.ts && npm run build`

Expected: all pricing cases pass and the stylesheet compiles.

- [ ] **Step 6: Commit contracts and theme**

```bash
git add viviai-web/src/types viviai-web/src/lib viviai-web/app
git commit -m "feat: add domain contracts and Midnight Studio theme"
```

---

### Task 3: Build the persistent Mock API platform

**Files:**
- Create: `viviai-web/src/mocks/fixtures.ts`
- Create: `viviai-web/src/mocks/db.ts`
- Create: `viviai-web/src/mocks/handlers.ts`
- Create: `viviai-web/src/mocks/browser.ts`
- Create: `viviai-web/src/mocks/server.ts`
- Create: `viviai-web/src/services/api.ts`
- Create: `viviai-web/src/services/queryKeys.ts`
- Test: `viviai-web/src/mocks/handlers.test.ts`

**Interfaces:**
- Consumes: domain types and `estimateCredits`
- Produces: `api.getMe`, `api.login`, `api.listModels`, `api.createGenerationTask`, `api.listAssets`, `api.listTemplates`, `api.createRemixTask`, `api.listTools`, `api.saveWorkflow`, `api.runWorkflow`, `api.listPlans`, `api.completeMockOrder`

- [ ] **Step 1: Write a failing API lifecycle test**

```ts
const created = await api.createGenerationTask({
  prompt: "透明香氛瓶，暖色电影光",
  modelId: "nano-banana-2",
  resolution: "1K",
  ratio: "1:1",
  count: 1,
});
expect(created.status).toBe("queued");
expect((await api.getMe()).credits).toBe(1116);
```

- [ ] **Step 2: Run the test and verify failure**

Run: `npm run test -- src/mocks/handlers.test.ts`

Expected: FAIL because service and handlers do not exist.

- [ ] **Step 3: Implement seeded fixtures and local persistence**

Create a deterministic demo user with 1,120 credits, five model configs, twelve inspiration items, nine remix templates, eight assets, three tools, three plans, notifications, and point-ledger records. `loadDb()` reads `viviai-mock-db-v1`; `resetDb()` restores the seed; `saveDb(next)` serializes every mutation.

- [ ] **Step 4: Implement typed fetch services**

```ts
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, init);
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body.message), { code: body.code });
  return body.data as T;
}
```

Export explicit methods rather than exposing `request` to components.

- [ ] **Step 5: Implement MSW handlers and task timers**

On task creation, validate auth, prompt, credits, and concurrency; freeze estimated credits; return `queued`; then advance to `processing` and finally `succeeded`, `partial`, or `failed` based on `x-mock-scenario`. Terminal transitions update balance, ledger, assets, and notifications atomically in `db.ts`.

- [ ] **Step 6: Run API tests**

Run: `npm run test -- src/mocks/handlers.test.ts`

Expected: queued creation, credit freezing, success asset creation, full failure refund, and partial-success deduction all pass.

- [ ] **Step 7: Commit the Mock API**

```bash
git add viviai-web/src/mocks viviai-web/src/services
git commit -m "feat: add persistent Mock API platform"
```

---

### Task 4: Implement providers, routing, and the application shell

**Files:**
- Create: `viviai-web/src/app/App.tsx`
- Create: `viviai-web/src/app/AppProviders.tsx`
- Create: `viviai-web/src/app/routes.tsx`
- Create: `viviai-web/src/app/ProtectedRoute.tsx`
- Create: `viviai-web/src/app/useNavigationItems.ts`
- Create: `viviai-web/src/components/shell/AppShell.tsx`
- Create: `viviai-web/src/components/shell/Sidebar.tsx`
- Create: `viviai-web/src/components/shell/Topbar.tsx`
- Create: `viviai-web/src/components/tasks/TaskDrawer.tsx`
- Create: `viviai-web/src/features/system/PlaceholderPage.tsx`
- Modify: `viviai-web/app/page.tsx`
- Test: `viviai-web/src/app/routes.test.tsx`

**Interfaces:**
- Consumes: `api.getMe`, query keys, Shadcn sidebar/sheet/dropdown-menu/sonner
- Produces: route tree, `ProtectedRoute`, persistent `AppShell`

- [ ] **Step 1: Write failing route tests**

```tsx
renderAppAt("#/create");
expect(await screen.findByRole("heading", { name: "图片生成" })).toBeVisible();

renderAppAt("#/assets", { authenticated: false });
expect(await screen.findByRole("heading", { name: "登录 VIVIAI" })).toBeVisible();
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm run test -- src/app/routes.test.tsx`

Expected: FAIL because providers and routes are missing.

- [ ] **Step 3: Implement providers and HashRouter routes**

Mount MSW before rendering in development, then mount QueryClientProvider, HashRouter, Toaster, and the application routes. Public routes are login, register, forgot password, inspiration, remix library/detail, and pricing; authenticated routes use `ProtectedRoute`.

- [ ] **Step 4: Implement the recognizable first product slice**

The first viewport must show the dark shell, active `图片生成` item, prompt composer placeholder, three representative recent results, credit pill, active task pill, and the asymmetrical 7:4 creation-stage/inspector layout. Use a narrow vertical “reference ribbon” beside the canvas as the memorable product-specific motif.

- [ ] **Step 5: Run route tests and build**

Run: `npm run test -- src/app/routes.test.tsx && npm run build`

Expected: routes render, protected routes redirect, and production build succeeds.

- [ ] **Step 6: Start the retained development server and perform the first preview handoff**

Run: `npm run dev`

Expected: the exact Local URL responds successfully and the page visibly represents Midnight Studio before further feature edits.

- [ ] **Step 7: Commit the shell**

```bash
git add viviai-web/app viviai-web/src/app viviai-web/src/components/shell viviai-web/src/components/tasks viviai-web/src/features/system
git commit -m "feat: add VIVIAI routing and application shell"
```

---

### Task 5: Implement authentication and the generation closed loop

**Files:**
- Create: `viviai-web/src/features/auth/AuthPage.tsx`
- Create: `viviai-web/src/features/auth/authDraft.ts`
- Create: `viviai-web/src/features/generation/CreatePage.tsx`
- Create: `viviai-web/src/features/generation/PromptComposer.tsx`
- Create: `viviai-web/src/features/generation/ModelParameterPanel.tsx`
- Create: `viviai-web/src/features/generation/CreditEstimator.tsx`
- Create: `viviai-web/src/features/generation/GenerationCard.tsx`
- Create: `viviai-web/src/features/generation/useGenerationTasks.ts`
- Create: `viviai-web/src/stores/sessionStore.ts`
- Test: `viviai-web/src/features/generation/CreatePage.test.tsx`

**Interfaces:**
- Consumes: auth and generation service methods, `estimateCredits`, AppShell
- Produces: login/register/reset forms, generation draft persistence, live task cards

- [ ] **Step 1: Write failing generation-flow tests**

```tsx
expect(screen.getByRole("button", { name: "开始生成" })).toBeDisabled();
await user.type(screen.getByLabelText("描述你想生成的画面"), "透明香氛瓶，暖色电影光");
expect(screen.getByText("预计消耗 4 积分")).toBeVisible();
await user.click(screen.getByRole("button", { name: "开始生成" }));
expect(await screen.findByText("正在排队")).toBeVisible();
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm run test -- src/features/generation/CreatePage.test.tsx`

Expected: FAIL because the generation form is missing.

- [ ] **Step 3: Implement authentication forms and redirect restoration**

Validate username/email, password, six-digit codes, confirmation password, and resend countdown. Store only the redirect target and form draft; successful login invalidates `me` and navigates back to the target hash route.

- [ ] **Step 4: Implement the generation composer and result feed**

Render prompt, reference upload, model, compatible quality/resolution/ratio, count, live credit estimate, and disabled reasons. Poll active tasks every 1.5 seconds and stop polling when none remain.

- [ ] **Step 5: Implement boundary states**

`INSUFFICIENT_CREDITS` opens PaywallDialog without clearing the draft; `CONCURRENCY_LIMIT` explains the active-task limit; `MODEL_UNAVAILABLE` keeps settings and prompts model selection; failed tasks expose retry.

- [ ] **Step 6: Run focused and full tests**

Run: `npm run test -- src/features/generation/CreatePage.test.tsx && npm run test`

Expected: validation, estimate, queue, failure, retry, and redirect restoration pass.

- [ ] **Step 7: Commit auth and generation**

```bash
git add viviai-web/src/features/auth viviai-web/src/features/generation viviai-web/src/stores
git commit -m "feat: add auth and image generation flow"
```

---

### Task 6: Implement inspiration, viral remix, and asset reuse

**Files:**
- Create: `viviai-web/src/features/inspiration/InspirationPage.tsx`
- Create: `viviai-web/src/features/inspiration/InspirationCard.tsx`
- Create: `viviai-web/src/features/remix/RemixLibraryPage.tsx`
- Create: `viviai-web/src/features/remix/RemixDetailPage.tsx`
- Create: `viviai-web/src/features/remix/RemixWorkbench.tsx`
- Create: `viviai-web/src/features/remix/TemplateCard.tsx`
- Create: `viviai-web/src/features/assets/AssetsPage.tsx`
- Create: `viviai-web/src/features/assets/AssetCard.tsx`
- Create: `viviai-web/src/features/assets/AssetPicker.tsx`
- Create: `viviai-web/src/features/assets/AssetPreviewDialog.tsx`
- Test: `viviai-web/src/features/remix/RemixWorkbench.test.tsx`
- Test: `viviai-web/src/features/assets/AssetsPage.test.tsx`

**Interfaces:**
- Consumes: template, remix-task, inspiration, and asset service methods
- Produces: searchable galleries, three-strength remix form, reusable asset picker

- [ ] **Step 1: Write failing remix and asset tests**

```tsx
expect(screen.getByRole("radio", { name: "平衡复刻" })).toBeChecked();
expect(screen.getByRole("button", { name: "开始复刻" })).toBeDisabled();
await user.type(screen.getByLabelText("描述你要修改的内容"), "替换为新款咖啡礼盒");
expect(screen.getByRole("button", { name: "开始复刻" })).toBeEnabled();
```

Verify asset search, favorite toggle, multi-select, delete confirmation, and undo.

- [ ] **Step 2: Run and confirm failure**

Run: `npm run test -- src/features/remix/RemixWorkbench.test.tsx src/features/assets/AssetsPage.test.tsx`

Expected: FAIL because remix and asset pages are missing.

- [ ] **Step 3: Implement inspiration and template galleries**

Combine search and category/platform/style filters in query parameters. Cards show image, creator or source type, platform-safe popularity copy, tags, favorite/like actions, and `做同款` or `复刻这张`.

- [ ] **Step 4: Implement template detail and RemixWorkbench**

Load template ID and version, render structured visual analysis, show the rights notice, require adaptation instructions, default to balanced strength, allow one optional subject asset, and submit a remix task through the shared task result components.

- [ ] **Step 5: Implement asset management and cross-feature reuse**

Support source/type/favorite filters, search, preview, download, rename, favorite, delete with undo, and batch actions. `作为参考图使用` stores the selected asset in the generation or remix draft and navigates to the chosen workspace.

- [ ] **Step 6: Run tests and build**

Run: `npm run test -- src/features/remix src/features/assets src/features/inspiration && npm run build`

Expected: all gallery, filter, remix validation, reuse, and deletion behaviors pass.

- [ ] **Step 7: Commit content workflows**

```bash
git add viviai-web/src/features/inspiration viviai-web/src/features/remix viviai-web/src/features/assets
git commit -m "feat: add inspiration remix and asset workflows"
```

---

### Task 7: Implement tools and the schema-driven runner

**Files:**
- Create: `viviai-web/src/features/tools/ToolsPage.tsx`
- Create: `viviai-web/src/features/tools/ToolCard.tsx`
- Create: `viviai-web/src/features/tools/ToolRunPage.tsx`
- Create: `viviai-web/src/features/tools/ToolSchemaForm.tsx`
- Test: `viviai-web/src/features/tools/ToolRunPage.test.tsx`

**Interfaces:**
- Consumes: tool fixtures, `AssetPicker`, shared model parameter panel, tool-run API
- Produces: searchable tool library and schema-rendered execution form

- [ ] **Step 1: Write failing required-field and upload-limit tests**

```tsx
renderTool("product-polish");
expect(screen.getByRole("button", { name: "开始生成" })).toBeDisabled();
await selectOneAsset();
await user.selectOptions(screen.getByLabelText("产品类型"), "护肤品");
expect(screen.getByRole("button", { name: "开始生成" })).toBeEnabled();
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm run test -- src/features/tools/ToolRunPage.test.tsx`

Expected: FAIL because the tool runner does not exist.

- [ ] **Step 3: Implement the tool library and schema renderer**

Render product polish, old-photo repair, and white-background product tools from typed field schemas. Enforce maximum asset counts of 1, 1, and 3 respectively and render required text/select/radio fields with accessible labels.

- [ ] **Step 4: Implement results and history tabs**

Use Shadcn tabs for current results and history, add list/grid display modes, search, empty states, and shared GenerationCard results.

- [ ] **Step 5: Run tests and commit**

Run: `npm run test -- src/features/tools && npm run build`

```bash
git add viviai-web/src/features/tools
git commit -m "feat: add schema driven AI tools"
```

---

### Task 8: Implement workflow editing and batch execution

**Files:**
- Create: `viviai-web/src/features/workflows/WorkflowsPage.tsx`
- Create: `viviai-web/src/features/workflows/WorkflowEditorPage.tsx`
- Create: `viviai-web/src/features/workflows/WorkflowGrid.tsx`
- Create: `viviai-web/src/features/workflows/ColumnConfigDialog.tsx`
- Create: `viviai-web/src/features/workflows/workflowMath.ts`
- Create: `viviai-web/src/features/tasks/TasksPage.tsx`
- Test: `viviai-web/src/features/workflows/workflowMath.test.ts`
- Test: `viviai-web/src/features/workflows/WorkflowEditorPage.test.tsx`

**Interfaces:**
- Consumes: workflow and batch APIs, AssetPicker, model pricing
- Produces: `summarizeWorkflow(workflow, selectedRowIds)`, saved workflows, batch tasks

- [ ] **Step 1: Write failing summary tests**

```ts
expect(summarizeWorkflow(defaultWorkflow, ["row-1", "row-2"])).toEqual({
  rows: 2,
  tasks: 2,
  completed: 0,
  processing: 0,
  failed: 0,
  estimatedCredits: 8,
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm run test -- src/features/workflows/workflowMath.test.ts`

Expected: FAIL because workflow summary logic is missing.

- [ ] **Step 3: Implement list and default draft creation**

New workflows use `工作流MMDD-HH:mm`, status `unsaved`, three rows, two reference columns, and one image-generation column. Unsaved drafts are stored in session state and excluded from the workflow list API.

- [ ] **Step 4: Implement the grid and column configuration**

Support row selection/add/delete, reference image cells, image-generation column dependencies, prompt/model/resolution/ratio settings, add/delete column, image fit/fill display, and zoom controls. Deletion uses AlertDialog.

- [ ] **Step 5: Implement save, selected-run, run-all, and task summaries**

Saving writes a new version. Running validates every selected row, shows total tasks and credits, creates a batch, and navigates to Task Center where child statuses roll up into completed/processing/failed counters.

- [ ] **Step 6: Run workflow tests and build**

Run: `npm run test -- src/features/workflows src/features/tasks && npm run build`

Expected: draft exclusion, save restore, summary calculation, selected run, and batch status pass.

- [ ] **Step 7: Commit workflows**

```bash
git add viviai-web/src/features/workflows viviai-web/src/features/tasks
git commit -m "feat: add workflow editor and batch tasks"
```

---

### Task 9: Implement pricing, account, notifications, and invites

**Files:**
- Create: `viviai-web/src/features/billing/PricingPage.tsx`
- Create: `viviai-web/src/features/billing/CheckoutDialog.tsx`
- Create: `viviai-web/src/features/account/AccountPage.tsx`
- Create: `viviai-web/src/features/account/PointLedger.tsx`
- Create: `viviai-web/src/features/invite/InvitePage.tsx`
- Create: `viviai-web/src/features/notifications/NotificationSheet.tsx`
- Test: `viviai-web/src/features/billing/CheckoutDialog.test.tsx`
- Test: `viviai-web/src/features/account/AccountPage.test.tsx`

**Interfaces:**
- Consumes: plans, orders, current user, ledger, notifications, invite APIs
- Produces: mock purchase completion, updated entitlements, account forms

- [ ] **Step 1: Write failing purchase-entitlement test**

```tsx
await user.click(screen.getByRole("button", { name: "购买高级版月卡" }));
await user.click(screen.getByRole("radio", { name: "支付宝" }));
await user.click(screen.getByRole("button", { name: "模拟支付成功" }));
expect(await screen.findByText("高级版月卡")).toBeVisible();
expect(await screen.findByText("2,000 积分")).toBeVisible();
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm run test -- src/features/billing/CheckoutDialog.test.tsx`

Expected: FAIL because checkout is missing.

- [ ] **Step 3: Implement plan comparison and mock checkout**

Render monthly, quarterly, annual, and enterprise groupings from API data. Checkout shows plan, cycle, credits, amount, Alipay/WeChat choice, pending state, and explicit `模拟支付成功` action; completion invalidates user, ledger, and notifications.

- [ ] **Step 4: Implement account, ledger, notifications, and invites**

Account exposes avatar preview, username/email, current plan, credits, concurrency, redemption code, change email, and change password forms. Invite page shows link-copy feedback, invite count, reward total, invite list, and point records. NotificationSheet supports read/unread state and links to related tasks.

- [ ] **Step 5: Run tests and commit**

Run: `npm run test -- src/features/billing src/features/account src/features/invite src/features/notifications && npm run build`

```bash
git add viviai-web/src/features/billing viviai-web/src/features/account viviai-web/src/features/invite viviai-web/src/features/notifications
git commit -m "feat: add billing and account experiences"
```

---

### Task 10: Add WebMCP task actions, end-to-end coverage, and final validation

**Files:**
- Create: `viviai-web/src/webmcp/registerTools.ts`
- Create: `viviai-web/e2e/generation.spec.ts`
- Create: `viviai-web/e2e/remix.spec.ts`
- Create: `viviai-web/e2e/workflow.spec.ts`
- Create: `viviai-web/e2e/billing.spec.ts`
- Modify: `viviai-web/src/app/AppProviders.tsx`
- Modify: `viviai-web/README.md`

**Interfaces:**
- Consumes: complete UI and service layer
- Produces: imperative `create_generation`, `start_remix`, and `reset_demo_data` tools plus browser-level acceptance tests

- [ ] **Step 1: Read the Sites WebMCP reference before implementation**

Run: `sed -n '1,260p' <sites-building-skill>/references/webmcp.md`

Expected: tool registration and input-schema requirements are understood before code changes.

- [ ] **Step 2: Write failing end-to-end tests**

```ts
test("login preserves the prompt and completes generation", async ({ page }) => {
  await page.goto("/#/create");
  await page.getByLabel("描述你想生成的画面").fill("透明香氛瓶，暖色电影光");
  await page.getByRole("button", { name: "开始生成" }).click();
  await page.getByLabel("用户名或邮箱").fill("demo@viviai.local");
  await page.getByLabel("密码").fill("demo1234");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByText("生成成功")).toBeVisible({ timeout: 10_000 });
});
```

Add equivalent exact flows for viral remix, workflow batch execution, and insufficient-credit purchase recovery.

- [ ] **Step 3: Run E2E tests and confirm uncovered failures**

Run: `npm run test:e2e`

Expected: failures identify any missing route wiring or state refresh.

- [ ] **Step 4: Register the three narrow WebMCP actions**

Each action validates inputs and delegates to the same service functions as the UI. Do not expose deletion, payment completion, password changes, or arbitrary request execution.

- [ ] **Step 5: Fix integration gaps and verify all routes**

Run:

```bash
npm run test
npm run test:e2e
npm run build
```

Expected: all commands exit 0. Manually verify route definitions cover every route in the design spec and that every navigation item leads to a real page.

- [ ] **Step 6: Perform responsive and accessibility checks**

Verify at 1440px, 1024px, and 390px: no horizontal page overflow, primary action remains visible, navigation becomes a drawer on mobile, dialogs fit the viewport, visible focus works, reduced-motion preference disables nonessential animation, and regular labels remain at least 14px.

- [ ] **Step 7: Update README with demo behavior**

Document the demo account `demo@viviai.local` / `demo1234`, the Mock scenario switcher, demo-data reset, scripts, and the single rule for backend replacement: disable MSW and point `src/services/api.ts` at the real API base URL.

- [ ] **Step 8: Commit the completed frontend**

```bash
git add viviai-web
git commit -m "test: verify complete VIVIAI frontend mock"
```

- [ ] **Step 9: Publish only after complete validation**

Follow `sites-hosting` to save a version, deploy the private Site, verify terminal deployment status, hand off the deployed URL, and stop the retained development server.

