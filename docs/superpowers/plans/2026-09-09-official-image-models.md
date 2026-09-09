# Official image model implementation plan

> Execution: subagent-driven-development. User explicitly approved plan + code in this turn; no intermediate approval pause. No live provider calls or real credentials.

Goal: Five exact official models work through existing backend job/wallet flow, with opt-in configuration and offline verification.

Architecture: Two REST adapters share bounded transport; model registry/config maps resolution × common-ratio presets to exact upstream IDs. Immutable execution/pricing snapshots propagate quote → job → attempt. Settlement separates customer credits and provider cost, and stages assets for local recovery.

Stack: Existing NestJS/Prisma/PostgreSQL/BullMQ/Node 22/TypeScript/Vitest; native fetch, no new SDK dependencies.

Spec: `docs/superpowers/specs/2026-09-09-official-image-models-design.md`.

### Task 1: Official protocol adapters and boundary tests

Owner: fresh implementer, isolated files only.
Create `viviai-server/src/modules/providers/official/{common,google,openai}.ts` and `viviai-server/test/official-adapters.test.ts`.

1. Write failing tests for Google all four exact models and OpenAI gpt-image-2 text and reference-image generation, using injected fetch and private ObjectStore. Observe RED.
2. Export `GoogleImageProvider` and `OpenAIImageProvider`, constructors `(store: ObjectStore, apiKey: string, fetcher?: typeof fetch)`. Google protocol `google-interactions-v1`, OpenAI `openai-images-v1`. Validate supported upstream IDs and exact specification using controller-owned `official-models.ts:getOfficialOutputSpec`, PNG, interactive, count=1; reject incompatible output/context. max references=2 except Lite=1 by request validation. User added common ratios and strict official pixel tables during execution; this supersedes initial square-only scope.
3. Verify Google current REST request/response at official URLs from spec (model_output steps, image content, usage). Never assume SDK output_image is raw REST. Legacy Gemini 2.5 omit image_size. All requests store=false where supported; no tools. OpenAI JSON generations / multipart edits; exact gpt-image-2, medium quality, omit response_format/input_fidelity. Label role and order with prompt text, validate image bytes SHA256 from store; no external image URL fetch.
4. Shared transport fixed official hosts, redirect:error, timeout honors context.signal and responseTimeoutMs, bounded read ≤136 MiB JSON, decoded image ≤96 MiB for 4K, safe error classification, no retry. Do not invent provider request IDs; OpenAI use x-request-id if present; Google actual id only. Malformed success output is accepted/billing unknown; network or 5xx unknown, terminal explicit auth/input/quota/rate-limit errors not accepted/not billable where defensible. Keep upstream messages private.
5. Normalize usage as integer token lines `input_text_tokens`, `input_image_tokens`, `output_text_tokens`, `output_image_tokens`, `thought_tokens` (Google). Preserve available lines but usageComplete only if totals reconcile and billable dimensions fully known; unknown/cached/tool dimensions not silently ignored. If output breakdown absent, OpenAI output_tokens is image output for this Images endpoint only if documented; otherwise incomplete. Tests for missing/partial/malformed/cached usage. Do not implement cost arithmetic here.
6. Test aborted before send vs after send, 401/429/500, malformed Base64, multiple/no image, thought images excluded, oversized response, duplicate-input order/hash, secrets never in returned errors, exactly one network call. GREEN + self-review; report RED/GREEN evidence. No live tests.

### Task 2: Config, catalog, execution, costs and durable materialization

Owner: controller; all files outside Task 1 ownership.

1. Write failing config/catalog/pricing and database integration tests. Baseline is 120 passing backend tests on 2026-09-09. Observe targeted RED before implementation.
2. Add reviewed five-model definitions, opt-in JSON config, per-model credits/cost version, shared account quota and budget, exact endpoint mapping. Disabled by default; missing key/prices fail closed. No secrets in catalog or snapshots. Extend AppConfig optionally so existing tests remain compatible.
3. Extend input model enum and CatalogService; model-specific reference limits; snapshot channel revision/spec/prices on GenerationQuote and GenerationJob with additive nullable JSON migration. Preserve old simulation jobs. Check snapshot compatibility at submission/dispatch. Do not change frontend.
4. Create runtime registry from AppConfig + ObjectStore; API catalog and Worker agree. Remove simulation-only Worker guard only for explicitly configured official channels. Routing still hard-filters exact model/spec/region; no cross-model fallback. Provider lease > configured HTTP timeout; jobs retain 15-minute delivery deadline.
5. Actual USD microcost from complete token usage + frozen versioned rates. Leave missing usage/cost unknown; keep budget reservation, release proven-complete remote slot. Preserve simulated estimated-cost behavior only for simulated=true records. Pass usageComplete through all paths.
6. Validate output against persisted allowed dimensions, generated asset source `generation`, not simulation. Persist stagedKey before final wallet/asset transaction; recover materialization locally without another provider submission. Any unavoidable response/storage crash gap is documented, never hidden behind retry.
7. Run full backend tests/build/typecheck/format and offline HTTP fixtures through real adapter → dispatch → wallet/asset path. Independently review security, accounting and recoverability; fix findings with regression tests. Add `.env.example` configuration and concise Chinese operator guide listing remaining live tests.

Acceptance: five models explicitly supported, no credentials required for tests, no paid request performed, unknown cost never zero/estimate-as-actual, no unrelated frontend edits, documented limits and truthful handoff.
