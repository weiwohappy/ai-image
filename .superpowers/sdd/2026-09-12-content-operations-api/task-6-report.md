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

- Content, marketing, navigation, and HTTP boundary: 4 files / 37 tests passed before the final campaign-conflict and published-permission extensions.
- Final content and marketing fix-round run: 2 files / 24 tests passed. The round began at 8 expected failures / 13 passes, then added two filter/dirty RED cases before implementation.

## Final verification

- Full admin test suite, run without competing build load: 19 files / 155 tests passed.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm run lint`: passed with no warnings.
- Changed admin source-file `oxfmt --check`: passed on 13 files.
- `git diff --check`: passed.

One resource-saturated run executed tests alongside typecheck and the production build; one pre-existing invitation test exceeded its five-second timeout. The same file passed 13/13 or 2/2 when isolated as applicable, and the final full suite passed 145/145 without concurrent build pressure.

## Scope and residual notes

- No payment page, public web page, backend API, private `Asset`, or generation runtime code was changed.
- The browser network inspector can inherently retain an authenticated response during a debugging session; the application itself does not persist, log, place in a URL, or make the one-time redemption plaintext reopenable.
- Server validation remains authoritative for model/spec availability, media reachability, prompt placeholders, campaign capacity, and lifecycle transitions. The UI presents safe validation metadata and never invents a mock fallback.
