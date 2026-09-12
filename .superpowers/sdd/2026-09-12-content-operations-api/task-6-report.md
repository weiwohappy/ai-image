# Task 6 report — content and marketing operations console

Status: complete

## Outcome

- Added permission-filtered `内容运营` and `营销运营` navigation groups. Icons now belong to navigation items instead of relying on a parallel positional array, and `ConsoleShell` explicitly routes every new resource screen.
- Added real API-backed inspiration, remix-template, tool-definition, and content-media screens. Content operators can filter and page stable server results, create drafts, edit versioned records, reorder, publish/offline/archive with confirmation, and preserve local drafts while loading the current server version after a 409.
- Added complete content provenance and generation inputs, a dedicated tool editor boundary, server 422 field binding, and safe field metadata handling in `AdminClient`. Audit reasons are length-checked and reject API keys, prompts, and embedded image material before a request is issued.
- Added a multipart `AdminClient.upload` path that retains the fixed `/api/admin` path boundary, same-origin session behavior, unauthorized invalidation, idempotency key, and envelope validation while allowing the browser to set the multipart boundary.
- Added a separate content-media library. It accepts only the approved raster types in the client, uploads to the content-media endpoint, exposes only an exact same-origin authenticated preview URL, and keeps private user `Asset` resources out of the UI.
- Added redemption campaign create/edit/disable/archive flows, capacity-error presentation, version-conflict reload without losing the draft, redemption-code/claim browsing, versioned code disable, referral browsing with only masked API identities, and stable cursor continuation.
- Added one-time redemption-code plaintext presentation. Plaintext exists only in the mounted success result; closing first clears the component state and unmounts the dialog. Reopening starts a fresh form and cannot restore the prior batch.
- All mutation controls require both the exact actor permission and the environment write gate. Each logical command attempt keeps one UUID idempotency key for its canonical payload (including uncertain retries), rotates it only for a changed payload or determinate failure, and sends the current record/campaign version and a bounded reason where required.

## Fix round 1

- Replaced the nonexistent media publish permission check with the approved `content.media.write` contract for publish, offline, and archive operations.
- Reworked content and campaign 409 recovery into an explicit field-by-field merge. The editor retains the local draft and latest server snapshot, shows both values, blocks resubmission until every conflict is resolved, and only then advances to the latest version.
- Added a shared mutation-attempt guard. Double submissions are blocked, pending editors and confirmations cannot be dismissed, uncertain requests retain the exact idempotency key and payload, and determinate validation/payload changes safely establish a new attempt.
- Hardened redemption-code generation as a single logical attempt. A pending or uncertain request blocks dismissal and navigation; uncertain delivery offers only an exact same-request retry. A safe receipt with `codesUnavailable` reports that the batch exists but plaintext cannot be recovered. Closing a successful result still destroys plaintext and it cannot be reopened.
- Added shared dirty-state protection for content/media/campaign/code work across editor close, sidebar/hash navigation, and `beforeunload`. Base UI modal primitives now provide accessible title/description, initial focus, focus trap/restore, Escape policy, background inertness, and consistent high-risk confirmation behavior.
- Added approved content/media updated-time filters and code/claim/referral campaign/user/status/time filters. Filter changes clear cursors; local datetime values are converted to offset-safe ISO instants, invalid ranges are rejected in place, and UUID filters are validated before transmission. The referral screen uses the approved backend's single `userId` filter, which matches inviter or invitee.
- Tool structured JSON now requires a plain top-level object before any property access. Lifecycle reason validation remains inside the active confirmation, marks the textarea invalid, and focuses it.

## Fix round 2

- Command-attempt identity now covers HTTP method, admin path, action, target, and a canonical payload. Reentrant calls share the same in-flight promise and return a discriminated result, so close/clear/refresh work runs only after an authoritative success. An uncertain outcome retains its exact key and command; every content, reorder, media, campaign, lifecycle, code-disable, and code-generation surface blocks other work and offers same-request retry or a separate Base UI confirmation before abandonment.
- Media upload identity includes a Web Crypto SHA-256 digest of the actual file bytes together with name, size, MIME type, and reason. File hashing is itself a guarded pending state, and selecting another file synchronously invalidates the previous digest before the browser can submit.
- Content conflict recovery now keeps the latest full record snapshot. Server lifecycle and immutable external identity are synchronized independently of editable field choices, status changes are shown as non-overridable facts, permissions/actions are recomputed from the latest status, archived records become read-only, and replacement payloads use the snapshot status. Campaign conflict recovery applies the same latest-record/status rule.
- Added campaign date-range, redemption-code keyword, and claim code-ID filters. Every supported filter setter and code/claim view switch clears a nonempty cursor before the next request.
- Dirty-state registration now reads the current discard callback and carries a monotonic revision, avoiding stale callbacks when blocker cardinality does not change. Global code-batch discard calls the plaintext-destroy path before close, and content/campaign/code lifecycle reasons participate in hash-navigation and `beforeunload` protection.

## Design decisions

- Followed the existing console language rather than introducing a new brand: the established blue/gray/red palette, system Chinese typography, dense operational tables, right-side editors, restrained thumbnails, and explicit lifecycle confirmation.
- Kept the one-time-code result as the only visually emphasized exceptional state because losing that plaintext is irreversible. Routine content and campaign work remains table-first and evidence-dense.
- Structured template analysis and tool field definitions remain JSON-backed because those are the approved API contracts; field-level server errors are safely mapped back to the structured editor without exposing private error messages.

## TDD evidence

Initial RED:

- `npm test -- src/content/ContentOperations.test.tsx src/marketing/MarketingOperations.test.tsx src/queries.test.tsx src/http.test.ts`
- Existing checks passed, while the new suites failed for the expected missing modules, missing operational navigation, absent multipart upload method, and absent safe 422 metadata.
- A later focused RED proved campaign 409 handling was missing before implementing conflict reload while preserving the operator's draft.

Focused GREEN:

- Round 1 content and marketing run: 2 files / 24 tests passed.
- Round 2 command-attempt, dirty registry, content, and marketing run: 4 files / 38 tests passed. The RED run reproduced undefined reentrant results, stale discard callbacks, missing media-byte hashing, stale lifecycle conflict state, missing filters/cursor resets, plaintext discard, and lifecycle dirty-state gaps before implementation.

## Final verification

- Full admin test suite: 21 files / 169 tests passed.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm run lint`: passed with no warnings.
- Changed admin source/test `oxfmt --check`: passed on 12 files.
- `git diff --check`: passed.

The first round-2 full run had one transient existing `AdminApp` enabled-state timing failure (167/168); that file passed 13/13 in isolation and the complete bounded rerun passed 169/169.

## Scope and residual notes

- No payment page, public web page, backend API, private `Asset`, or generation runtime code was changed.
- The browser network inspector can inherently retain an authenticated response during a debugging session; the application itself does not persist, log, place in a URL, or make the one-time redemption plaintext reopenable.
- Server validation remains authoritative for model/spec availability, media reachability, prompt placeholders, campaign capacity, and lifecycle transitions. The UI presents safe validation metadata and never invents a mock fallback.
