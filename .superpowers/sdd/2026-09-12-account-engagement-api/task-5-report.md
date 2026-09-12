# Task 5 report — account and engagement web integration

Status: complete (review fix round 1/5)

Commit: `a1452e8 feat(web): connect account and engagement APIs` (review fix round 1/5)

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

Concerns: none. No payment or admin files changed, and no database or secrets were accessed.
