# Content Operations API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist inspirations, viral remix templates, AI tool definitions, and operational media; expose published content to users and full lifecycle management to authorized operators.

**Architecture:** Store versioned content records and separate operational media in PostgreSQL/object storage. Public queries project only published records with user interaction state, while admin commands enforce permissions, optimistic versioning, publish validation, idempotency, and audit logging.

**Tech Stack:** TypeScript, NestJS, Prisma/PostgreSQL, Zod, Vitest, React, TanStack Query, vinext, existing object-store abstraction.

**Spec:** `docs/superpowers/specs/2026-09-12-viviai-non-payment-full-api-design.md`

## Global Constraints

- Complete `2026-09-12-account-engagement-api.md` first; this plan consumes user identity, notifications, and the expanded permission system patterns.
- Do not expose draft, offline, or archived content through public routes.
- Operational media and private user assets must use different database entities and authorization rules.
- Published tools must reference an enabled model/spec and an active model credit price.
- Content deletion is archival; historical generation snapshots remain readable.
- All admin mutations require an idempotency key, a reason where applicable, a current version, and an audit event.
- Do not change payment behavior.

---

### Task 1: Add versioned content and operational media schemas

**Files:**
- Modify: `viviai-server/prisma/schema.prisma`
- Create: `viviai-server/prisma/migrations/20260912020000_content_operations/migration.sql`
- Modify: `viviai-server/test/helpers/database.ts`
- Test: `viviai-server/test/integration/content-schema.test.ts`

**Interfaces:**
- Produces: `ContentMedia`, `Inspiration`, `InspirationLike`, `RemixTemplate`, `RemixTemplateFavorite`, and `ToolDefinition` Prisma models.
- Produces: common lifecycle values `draft`, `published`, `offline`, and `archived` stored as validated strings.

- [ ] **Step 1: Write the failing schema tests**

```ts
it('enforces one like and one favorite per user and content item', async () => {
  await db.inspirationLike.create({ data: { userId, inspirationId } });
  await expect(
    db.inspirationLike.create({ data: { userId, inspirationId } }),
  ).rejects.toMatchObject({ code: 'P2002' });
});
```

Also assert stable `externalId` uniqueness, positive versions, unique content-media object keys, and sort indexes.

- [ ] **Step 2: Run the schema test to confirm missing models**

Run: `cd viviai-server && npm test -- test/integration/content-schema.test.ts`
Expected: FAIL because content models do not exist.

- [ ] **Step 3: Add focused Prisma models**

Store structured fields as JSON only where they are edited as a unit:

```prisma
model ToolDefinition {
  id               String   @id @default(uuid()) @db.Uuid
  externalId       String   @unique @map("external_id")
  name             String
  description      String
  category         String
  fieldSchema      Json     @map("field_schema")
  promptTemplate   String   @map("prompt_template")
  defaults         Json
  maxAssets        Int      @map("max_assets")
  assetLabel       String   @map("asset_label")
  status           String   @default("draft")
  version          Int      @default(1)
  sortOrder        Int      @default(0) @map("sort_order")
  createdAt        DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt        DateTime @updatedAt @map("updated_at") @db.Timestamptz(6)
  @@index([status, sortOrder, updatedAt])
  @@map("tool_definitions")
}
```

Add media relations, tags/analysis/default parameters, creator/source metadata, published timestamps, `createdByAdminId`, `updatedByAdminId`, and unique join-table keys.

- [ ] **Step 4: Write the migration with status/version checks and indexes**

Add database checks for lifecycle status, `version >= 1`, `sort_order >= 0`, valid media dimensions, and `max_assets` between 0 and the product maximum. Do not create cascade paths that remove historical content unexpectedly.

- [ ] **Step 5: Generate the client and rerun tests**

Run: `cd viviai-server && npm run prisma:generate && npm test -- test/integration/content-schema.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit content persistence**

```bash
git add viviai-server/prisma/schema.prisma viviai-server/prisma/migrations/20260912020000_content_operations viviai-server/test/helpers/database.ts viviai-server/test/integration/content-schema.test.ts
git commit -m "feat(server): add operational content schema"
```

### Task 2: Import current Mock catalogs as idempotent seed data

**Files:**
- Create: `viviai-server/src/modules/content/content-contracts.ts`
- Create: `viviai-server/src/scripts/seed-content.ts`
- Modify: `viviai-server/package.json`
- Test: `viviai-server/test/integration/content-seed.test.ts`
- Read-only source: `viviai-web/src/mocks/fixtures.ts`

**Interfaces:**
- Produces: validated `inspirationInputSchema`, `remixTemplateInputSchema`, and `toolDefinitionInputSchema`.
- Produces: `npm run seed:content`, safe to run repeatedly.

- [ ] **Step 1: Write a failing idempotency test**

Run the seed twice and assert the same record counts, stable external IDs, and no version increments when the fixture content digest is unchanged.

- [ ] **Step 2: Run the seed test and confirm the script is missing**

Run: `cd viviai-server && npm test -- test/integration/content-seed.test.ts`
Expected: FAIL with missing module/script.

- [ ] **Step 3: Define strict content input schemas**

Reject unknown keys and validate internal references:

```ts
export const lifecycleSchema = z.enum(['draft', 'published', 'offline', 'archived']);
export const toolFieldSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/),
  label: z.string().trim().min(1).max(80),
  type: z.enum(['text', 'select', 'radio']),
  required: z.boolean(),
  options: z.array(z.object({ label: z.string(), value: z.string() }).strict()).optional(),
}).strict();
```

- [ ] **Step 4: Implement digest-aware upserts**

Use stable fixture IDs as `externalId`. Insert as `published` only when every referenced media file has been imported successfully; otherwise fail the whole seed with a useful file name. Repeated identical imports update neither version nor timestamps.

- [ ] **Step 5: Rerun the seed test**

Run: `cd viviai-server && npm test -- test/integration/content-seed.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit seed import**

```bash
git add viviai-server/src/modules/content/content-contracts.ts viviai-server/src/scripts/seed-content.ts viviai-server/package.json viviai-server/test/integration/content-seed.test.ts
git commit -m "feat(server): seed operational content catalogs"
```

### Task 3: Implement public content, likes, and favorites

**Files:**
- Create: `viviai-server/src/modules/content/content.module.ts`
- Create: `viviai-server/src/modules/content/public-content.controller.ts`
- Create: `viviai-server/src/modules/content/public-content.service.ts`
- Create: `viviai-server/src/modules/content/content-presenter.ts`
- Modify: `viviai-server/src/app.module.ts`
- Test: `viviai-server/test/integration/public-content.test.ts`

**Interfaces:**
- Produces: public inspiration, remix-template, tool list/detail DTOs matching `viviai-web/src/types/domain.ts`.
- Produces: idempotent `POST` and `DELETE` interaction routes.

- [ ] **Step 1: Write failing public-query tests**

Test published-only filtering, sort order, category filters, user-specific liked/favorite state, safe media URLs, missing/offline detail behavior, and cross-user interaction isolation.

- [ ] **Step 2: Run the test and verify 404 failures**

Run: `cd viviai-server && npm test -- test/integration/public-content.test.ts`
Expected: FAIL because the routes are absent.

- [ ] **Step 3: Implement public read routes**

Expose:

```text
GET /api/inspirations
GET /api/remix-templates
GET /api/remix-templates/:id
GET /api/tools
GET /api/tools/:id
GET /api/content-media/:id/content
```

Use optional authentication for catalog reads so signed-out discovery still works; attach `liked`/`favorite` only for a resolved session. Cap page size at 50 and use stable cursor ordering `(sortOrder, id)`. Stream operational media only when it is referenced by at least one currently published content record, return an image MIME allowlist, strong ETag, and public cache headers; admin preview uses its separately authenticated route.

- [ ] **Step 4: Implement authenticated interaction routes**

Expose explicit `POST` and `DELETE` routes for likes/favorites. Use upsert/deleteMany so replays succeed without changing counters twice. Derive counts from database state or transactionally maintained values; never trust a client count.

- [ ] **Step 5: Rerun the public content tests**

Run: `cd viviai-server && npm test -- test/integration/public-content.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit public content APIs**

```bash
git add viviai-server/src/modules/content viviai-server/src/app.module.ts viviai-server/test/integration/public-content.test.ts
git commit -m "feat(server): expose published content catalogs"
```

### Task 4: Add content media upload and admin lifecycle commands

**Files:**
- Create: `viviai-server/src/modules/admin/content/content.controller.ts`
- Create: `viviai-server/src/modules/admin/content/content.service.ts`
- Create: `viviai-server/src/modules/admin/content/media.service.ts`
- Create: `viviai-server/src/modules/admin/content/publish-validator.ts`
- Modify: `viviai-server/src/modules/admin/admin.module.ts`
- Modify: `viviai-server/src/modules/admin/permission-catalog.ts`
- Test: `viviai-server/test/integration/admin-content.test.ts`
- Test: `viviai-server/test/admin-content-permissions.test.ts`

**Interfaces:**
- Produces: `AdminContentService.create/update/transition/reorder/archive`.
- Produces: operational media upload, metadata read, and safe content response routes.
- Consumes: `AdminAuditService`, `requirePermission`, `AdminCommandReceipt`, model catalog, pricing, and object store.

- [ ] **Step 1: Write failing permission and lifecycle tests**

Assert `read`, `write`, and `publish` dependencies; super-admin access; content-operator defaults; version conflicts; invalid state transitions; missing model pricing; unsafe prompt placeholders; media validation; and sanitized audit payloads.

- [ ] **Step 2: Run admin content tests**

Run: `cd viviai-server && npm test -- test/admin-content-permissions.test.ts test/integration/admin-content.test.ts`
Expected: FAIL because permissions and controllers are missing.

- [ ] **Step 3: Extend the permission catalog**

Add the exact permission keys from the spec. Configure dependencies such that `*.write` requires `*.read`, `*.publish` requires both, and `content_operator` receives content read/write/publish plus media read/write. Keep customer-sensitive access excluded.

Use the existing `teamWritesEnabled` environment policy as the global command gate in addition to resource permission checks. This preserves the current loopback-development safety boundary without introducing a second write-gate configuration.

- [ ] **Step 4: Implement media upload and content commands**

All commands accept a body containing `version` and `reason` where a record already exists. Compare versions inside the transaction, increment on material changes, and return `409 CONTENT_VERSION_CONFLICT` on mismatch. Use this transition table:

```ts
const transitions = {
  draft: ['published', 'archived'],
  published: ['offline'],
  offline: ['published', 'archived'],
  archived: [],
} as const;
```

- [ ] **Step 5: Validate publish readiness on the server**

Resolve every media reference, parse structured JSON with shared schemas, verify prompt placeholders exist in the declared tool fields, verify the model/spec is enabled, and verify a current `ModelCreditPrice`. Return field-level `422` errors without writing a partial transition.

- [ ] **Step 6: Rerun admin content tests**

Run: `cd viviai-server && npm test -- test/admin-content-permissions.test.ts test/integration/admin-content.test.ts test/integration/admin-auth.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit admin content backend**

```bash
git add viviai-server/src/modules/admin/content viviai-server/src/modules/admin/admin.module.ts viviai-server/src/modules/admin/permission-catalog.ts viviai-server/test/admin-content-permissions.test.ts viviai-server/test/integration/admin-content.test.ts
git commit -m "feat(admin-api): manage operational content"
```

### Task 5: Add redemption and referral admin operations

**Files:**
- Create: `viviai-server/src/modules/admin/marketing/marketing.controller.ts`
- Create: `viviai-server/src/modules/admin/marketing/marketing.service.ts`
- Modify: `viviai-server/src/modules/admin/admin.module.ts`
- Modify: `viviai-server/src/modules/admin/permission-catalog.ts`
- Test: `viviai-server/test/integration/admin-marketing.test.ts`

**Interfaces:**
- Produces: campaign/code CRUD, one-time generated code export payload, and referral queries.
- Consumes: account-engagement schema and `AdminAuditService`.

- [ ] **Step 1: Write failing marketing tests**

Test campaign lifecycle, batch code uniqueness, single-response plaintext, subsequent masked reads, code disabling, claim pagination, permission rejection, and no plaintext recovery from the database.

- [ ] **Step 2: Run the marketing tests**

Run: `cd viviai-server && npm test -- test/integration/admin-marketing.test.ts`
Expected: FAIL because routes are absent.

- [ ] **Step 3: Implement campaign and code commands**

Generate codes with `randomBytes`, return plaintext only from the create-batch response, and persist only `sha256(normalizedCode)` plus a display mask. Validate quantity `1..1000`, campaign limits, expiry, and idempotency before insert.

- [ ] **Step 4: Implement redacted referral reads**

Expose paginated `/admin/referrals` with inviter/invitee identifiers, masked emails, state, reward amount, and timestamps. Do not return authentication data or unrelated user profile fields. Workflow and batch resources are added only after their schema exists in the workflow-batch plan.

- [ ] **Step 5: Rerun marketing and sensitive-data tests**

Run: `cd viviai-server && npm test -- test/integration/admin-marketing.test.ts test/integration/admin-sensitive.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit marketing operations**

```bash
git add viviai-server/src/modules/admin/marketing viviai-server/src/modules/admin/admin.module.ts viviai-server/src/modules/admin/permission-catalog.ts viviai-server/test/integration/admin-marketing.test.ts
git commit -m "feat(admin-api): manage redemption campaigns"
```

### Task 6: Build operational content and marketing screens

**Files:**
- Create: `viviai-admin/src/content/contracts.ts`
- Create: `viviai-admin/src/content/ContentListPage.tsx`
- Create: `viviai-admin/src/content/ContentEditor.tsx`
- Create: `viviai-admin/src/content/MediaLibraryPage.tsx`
- Create: `viviai-admin/src/content/ToolDefinitionEditor.tsx`
- Create: `viviai-admin/src/marketing/CampaignPage.tsx`
- Create: `viviai-admin/src/marketing/CodeBatchDialog.tsx`
- Modify: `viviai-admin/src/navigation.ts`
- Modify: `viviai-admin/src/ConsoleShell.tsx`
- Modify: `viviai-admin/src/http.ts`
- Test: `viviai-admin/src/content/ContentOperations.test.tsx`
- Test: `viviai-admin/src/marketing/MarketingOperations.test.tsx`
- Modify: `viviai-admin/src/queries.test.tsx`

**Interfaces:**
- Consumes: admin APIs from Tasks 4–5.
- Produces: permission-gated CRUD/editor UI for content and campaigns.

- [ ] **Step 1: Write failing navigation and editor tests**

Assert menu groups, permission filtering, draft creation, dirty-form warnings, field-level publish failures, version-conflict refresh, one-time code display, and that plaintext codes disappear after closing the result dialog.

- [ ] **Step 2: Run focused admin tests**

Run: `cd viviai-admin && npm test -- src/content/ContentOperations.test.tsx src/marketing/MarketingOperations.test.tsx src/queries.test.tsx`
Expected: FAIL because pages/routes are missing.

- [ ] **Step 3: Extend `AdminClient` for multipart media without weakening path checks**

Add a dedicated method that still uses `adminPath`, session invalidation, and response-envelope validation:

```ts
upload<T>(path: string, body: FormData, idempotencyKey: string, signal?: AbortSignal): Promise<T>
```

Do not set `Content-Type` manually for `FormData`.

- [ ] **Step 4: Implement navigation and resource screens**

Add groups `内容运营` and `营销运营`, with icons mapped by navigation item rather than parallel array position. Route each custom editor explicitly in `ConsoleShell`. The `任务运营` group is added by the workflow-batch plan after those resources exist.

- [ ] **Step 5: Implement accessible editors and lifecycle confirmation**

Use labeled controls, visible validation, disabled unauthorized actions, version in every update, reason input for publish/offline/archive, and explicit confirmation for destructive lifecycle changes. Never place API keys, user prompts, or customer image data in reasons.

- [ ] **Step 6: Rerun admin tests and quality checks**

Run: `cd viviai-admin && npm test -- src/content/ContentOperations.test.tsx src/marketing/MarketingOperations.test.tsx src/queries.test.tsx && npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 7: Commit admin screens**

```bash
git add viviai-admin/src/content viviai-admin/src/marketing viviai-admin/src/navigation.ts viviai-admin/src/ConsoleShell.tsx viviai-admin/src/http.ts viviai-admin/src/queries.test.tsx
git commit -m "feat(admin): add content and marketing operations"
```

### Task 7: Connect inspiration and remix-template pages to public APIs

**Files:**
- Modify: `viviai-web/src/services/api.ts`
- Modify: `viviai-web/src/services/queryKeys.ts`
- Modify: `viviai-web/src/types/domain.ts`
- Modify: `viviai-web/src/features/inspiration/InspirationPage.tsx`
- Modify: `viviai-web/src/features/remix/RemixLibraryPage.tsx`
- Modify: `viviai-web/src/features/remix/RemixDetailPage.tsx`
- Modify: `viviai-web/src/features/remix/RemixPage.tsx`
- Modify: `viviai-web/src/app/routes.tsx`
- Test: `viviai-web/src/services/api.test.ts`
- Create: `viviai-web/src/features/inspiration/InspirationPage.test.tsx`
- Create: `viviai-web/src/features/remix/RemixLibraryPage.test.tsx`
- Modify: `viviai-web/src/app/routes.test.tsx`

**Interfaces:**
- Consumes: public content routes from Task 3.
- Produces: real-mode inspiration and platform-template UX with explicit like/favorite operations.

- [ ] **Step 1: Write failing real-mode page tests**

Test published lists, filters, loading/empty/error states, optimistic like/favorite rollback, template detail, route availability, and an offline template becoming unavailable without losing an already-created task.

- [ ] **Step 2: Run focused tests**

Run: `cd viviai-web && npm test -- src/services/api.test.ts src/features/inspiration/InspirationPage.test.tsx src/features/remix/RemixLibraryPage.test.tsx src/app/routes.test.tsx`
Expected: FAIL because real routes are gated and toggles use Mock-only POST semantics.

- [ ] **Step 3: Implement explicit API methods and stable query keys**

Replace toggles with:

```ts
likeInspiration(id: string): Promise<Inspiration>
unlikeInspiration(id: string): Promise<Inspiration>
favoriteTemplate(id: string): Promise<ViralTemplate>
unfavoriteTemplate(id: string): Promise<ViralTemplate>
```

- [ ] **Step 4: Remove real-mode route gates and add rollback behavior**

Update the cached item immediately, call the command, replace it with the server DTO on success, and restore the captured previous list on failure. Show a retry control for query failures.

- [ ] **Step 5: Rerun tests and frontend checks**

Run: `cd viviai-web && npm test -- src/services/api.test.ts src/features/inspiration/InspirationPage.test.tsx src/features/remix/RemixLibraryPage.test.tsx src/app/routes.test.tsx && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit public frontend integration**

```bash
git add viviai-web/src/services viviai-web/src/types/domain.ts viviai-web/src/features/inspiration viviai-web/src/features/remix viviai-web/src/app/routes.tsx viviai-web/src/app/routes.test.tsx
git commit -m "feat(web): connect inspiration and template catalogs"
```

### Task 8: Verify the content operations vertical slice

**Files:**
- Create: `viviai-admin/scripts/admin-content-http-smoke.mjs`
- Modify: `viviai-admin/package.json`
- No other planned file changes; a failure returns execution to the owning task.

**Interfaces:**
- Verifies: seed idempotency, content lifecycle, permissions, user interactions, and admin audit safety.

- [ ] **Step 1: Apply migration and seed content twice**

Run: `cd viviai-server && npm run prisma:migrate && npm run seed:content && npm run seed:content`
Expected: both seed runs succeed; the second reports no duplicate inserts.

- [ ] **Step 2: Run all backend tests and type checks**

Run: `cd viviai-server && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Run all admin checks**

Run: `cd viviai-admin && npm test && npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 4: Run all user frontend checks**

Run: `cd viviai-web && npm test && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 5: Add and run the content HTTP smoke test**

Implement `admin-content-http-smoke.mjs` using the existing admin smoke harness. It must log in as a content operator, create a draft inspiration, update it with the returned version, publish it, verify it appears on `/api/inspirations`, take it offline, and verify public detail returns `404`. Add `"smoke:content": "TSX_TSCONFIG_PATH=../viviai-server/tsconfig.json node --import ../viviai-server/node_modules/tsx/dist/loader.mjs scripts/admin-content-http-smoke.mjs"` to package scripts.

Run: `cd viviai-admin && npm run smoke && npm run smoke:team && npm run smoke:pricing && npm run smoke:content`
Expected: existing smoke coverage and the full content lifecycle smoke test pass.

- [ ] **Step 6: Commit the content smoke coverage**

```bash
git add viviai-admin/scripts/admin-content-http-smoke.mjs viviai-admin/package.json
git commit -m "test(admin): smoke test content lifecycle"
```
