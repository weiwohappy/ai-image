# Task 5 report — account and engagement web integration

Status: complete

Commit: `feat(web): connect account and engagement APIs`

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

Concerns: none. No payment or admin files changed, and no database or secrets were accessed.
