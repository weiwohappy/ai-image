# Task 5 report — account and engagement web integration

Status: complete (review fix round 3/5)

Latest implementation commit: `0a08e97 fix(web): close account redemption and mock races`

## Files

- Updated the API client, public error union, account center, notification sheet, invite page, registration flow, invite route, topbar notification control, and mock handlers.
- Added focused real-mode tests for notification, invite, and invite registration; expanded API, account, route, and mock handler coverage.

## RED / GREEN

- RED: `npm test -- src/services/api.test.ts src/features/account/AccountPage.test.tsx src/features/notifications/NotificationSheet.test.tsx src/features/invite/InvitePage.test.tsx src/features/auth/InviteRegistration.test.tsx src/app/routes.test.tsx` failed for the intended gaps: missing avatar API client method, real-mode-disabled account/notification controls, hard-coded invite origin, and omitted registration invite code.
- GREEN: the same focused command passed 6 files / 17 tests after implementation.

## Verification

- Focused frontend suite: 6 files / 17 tests passed.
- Full `viviai-web` suite: 20 files / 59 tests passed.
- `npm run lint`: passed.
- `npm run build`: passed (the build prints vinext's existing `punycode` deprecation warning and dynamic-route classification notice only).
- `git diff --check`: passed.

## Self-review

- Verified exact backend paths and bodies against Tasks 2–4 controllers: avatar is `FormData` under `file`; email/password use `/account/change-email` and `/account/change-password`; redemption carries `Idempotency-Key`.
- Avatar previews use object URLs, revoke on replacement/unmount, and upload only after Save; the returned authoritative user refreshes the account cache.
- Redemption retains an idempotency key until a response succeeds or the user edits the code; the displayed award is calculated from pre/post account credits.
- Notification cache updates cover single and all-read commands, with loading, empty, retry, unread, and internal-link safety states. Invite links are based on the current origin and hash-router registration route.
- Credential APIs retain the shared `401` auth-expiry dispatch behavior from the API transport and update the authenticated user cache on success.

## Review fix round 1/5

- Account avatar URLs now use `apiResourceUrl` for relative backend asset paths both while rendering and when authoritative user results update the cache. Object URL previews still upload only on Save and revoke replaced/unmounted previews.
- Redemption records a logical `{ normalizedCode, key, baselineCredits }` attempt. Definitive 4xx responses clear it; network/no-response and 5xx outcomes retain it. The success amount is clamped to a non-negative authoritative balance delta, and success invalidates `me`, point ledger, and notifications.
- Notification sheet and topbar expose numeric unread counts. Mark-one/all cache behavior remains intact.
- Mock contracts now model invite validation/reward, purpose-isolated single-use codes, 12-character passwords, and idempotency replay/conflict behavior.
- A profile save now immediately synchronizes the username response; an avatar follow-up failure reports explicit partial success. Clipboard absence reports a manual-copy error and never claims success.

### Round 1 RED / GREEN

- RED: focused account, notification, invite, and mock-handler regressions exposed the missing API-origin avatar resolution, partial-save state, unread count, clipboard fallback, invalidation, logical redemption attempts, and mock fidelity.
- GREEN: `npm test -- src/features/account/AccountPage.test.tsx src/features/notifications/NotificationSheet.test.tsx src/features/invite/InvitePage.test.tsx src/mocks/handlers.test.ts --reporter=dot` passed 4 files / 27 tests.

### Round 1 verification

- Full `npm test -- --reporter=dot`: passed 20 files / 69 tests.
- `npm run lint`: passed.
- `npm run build`: passed (existing `punycode` deprecation and vinext dynamic-route notices only).
- `git diff --check`: passed.

Round 1 self-review: no auth values are logged or rendered. Relative and absolute avatar source handling is covered; retry state does not inherit a post-refresh balance. No payment, admin, backend, database, or secret changes were made.

## Review fix round 2/5

Commit: `7202383 fix(web): harden redemption retries and mocks`

- An edited or replacement redemption after an uncertain outcome now blocks submission while it fetches an authoritative account balance. It uses that fresh balance as the new attempt baseline; a refresh failure leaves the replacement unsubmitted and reports a retryable error. Retrying the unchanged uncertain attempt still uses its original key and baseline.
- Mock registration validates invite eligibility before consuming the registration challenge, then consumes the code, user state, rewards, and notifications together. It now exposes backend `INVALID_CODE` responses for invalid/used purpose-specific challenges.
- Mock redemption now uses the backend idempotency-key expression `[A-Za-z0-9_-]{16,100}`, emits exactly one safe unread credits notification for a successful claim, and replays neither credits nor notification.

### Round 2 RED / GREEN

- RED: 6 focused failures proved the stale replacement baseline, refresh-failure submission, invitation code consumption, challenge error code, idempotency-key bounds, and redemption notification gaps.
- GREEN: `npm test -- src/features/account/AccountPage.test.tsx src/mocks/handlers.test.ts --reporter=dot` passed 2 files / 29 tests. The account regression verifies `A → /me refresh → B` ordering and a `+100` result from `1120 → 1220 → 1320`; a failed refresh prevents B entirely.

### Round 2 verification

- Full `npm test -- --reporter=dot`: passed 20 files / 74 tests.
- `npm run lint`: passed.
- `npm run build`: passed (existing `punycode` deprecation and vinext dynamic-route notices only).
- `git diff --check`: passed.

Round 2 self-review: replacement attempts cannot race the baseline refresh; no stale cached balance is used after abandoning an uncertain attempt. Mock error/status and idempotency behavior were read directly against the server implementations. No admin, payment, backend, database, or secret files changed.

Concerns: none. No payment or admin files changed, and no database or secrets were accessed.

## Review fix round 3/5

Commit: `0a08e97 fix(web): close account redemption and mock races`

- Redemption now acquires a synchronous ref/state submission lock before baseline refresh or mutation. The code field and submit button stay disabled until the entire logical attempt reaches success, a definitive failure, an uncertain response, or a failed replacement-baseline refresh. The ref guard also rejects same-tick Enter/double-click attempts before React re-renders.
- Mock registration normalizes and validates the backend registration schema before it reads or mutates persistent registration state. Existing email/username conflicts return `409 ACCOUNT_EXISTS` before challenge consumption. The final commit re-checks duplicate, challenge, and invite state before consuming the code and applying account/reward/session changes.
- Invalid and unknown invites now have deep state assertions: user, session, ledger, notifications, referrals, challenges, and credential hash remain unchanged. Registration fixtures use backend-valid lowercase usernames.

### Round 3 RED / GREEN

- RED: `npm test -- --run src/features/account/AccountPage.test.tsx src/mocks/handlers.test.ts` failed 4 focused regressions on the pre-fix code: two editable redemption races, existing-email/self-invite account replacement, and duplicate-username account replacement.
- GREEN: the same focused command passed 2 files / 33 tests. The pending-A test verifies the input remains `A` and exactly one `A` request is sent; the pending replacement-baseline test verifies the edited input remains `B` and only `B` is submitted after the authoritative refresh. Mock tests assert deep rollback state and an unconsumed code remains usable after rejected validation/invite attempts.

### Round 3 verification

- Full `npm test`: passed 20 files / 78 tests.
- `npm run lint`: passed.
- `npm run build`: passed (existing `punycode` deprecation and vinext dynamic-route classification notices only).
- `git diff --check`: passed before commit; staged diff check passed before commit.

Round 3 self-review: the lock prevents code edits and duplicate submits while any mutation or authoritative replacement-balance fetch is active, while preserving unchanged uncertain retries and existing refresh-failure behavior. Registration never calls `setCredentialHash` or consumes the challenge before all observable validation passes. No payment, admin, server, database, or secret files changed.

Concerns: browser UI tests cover controlled input and click behavior; the synchronous ref additionally guards the brief interval before disabled attributes render.
