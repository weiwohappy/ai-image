# Account and Engagement API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Mock-only account, notification, invite, and redemption behavior with durable authenticated APIs and connect the existing user pages to them.

**Architecture:** Extend the identity module with a reusable email-challenge service and a focused account module. Store notification, referral, and redemption state in PostgreSQL, use the existing wallet ledger for rewards, and expose only user-scoped DTOs.

**Tech Stack:** TypeScript, NestJS, Prisma/PostgreSQL, Zod, Vitest, React, TanStack Query, vinext.

**Spec:** `docs/superpowers/specs/2026-09-12-viviai-non-payment-full-api-design.md`

## Global Constraints

- Do not change payment routes, payment schemas, or payment callbacks.
- Passwords remain at least 12 characters; all account-changing codes are six digits, single-use, purpose-bound, and expire after 600 seconds.
- User assets remain private; avatar upload must verify ownership and image content.
- Every reward creates idempotent `CreditLot` and `CreditEvent` records through `WalletService`-compatible semantics.
- Never return password hashes, verification-code material, raw redemption-code digests, or another user's private data.
- Write tests before implementation and commit only the files named by each task.

---

### Task 1: Persist account, notification, referral, and redemption state

**Files:**
- Modify: `viviai-server/prisma/schema.prisma`
- Create: `viviai-server/prisma/migrations/20260912010000_account_engagement/migration.sql`
- Modify: `viviai-server/test/helpers/database.ts`
- Test: `viviai-server/test/integration/account-schema.test.ts`

**Interfaces:**
- Produces: Prisma models `Notification`, `Referral`, `RedemptionCampaign`, `RedemptionCode`, and `RedemptionClaim`.
- Produces: `User.avatarAssetId`, `User.inviteCode`, `User.invitedByUserId`, and `User.updatedAt`.

- [ ] **Step 1: Write the failing migration contract test**

```ts
it('persists one referral and one redemption claim per user and source', async () => {
  const userInput = (name: string) => ({
    email: `${name}@example.test`,
    username: name,
    passwordHash: 'test-only-hash',
    inviteCode: name.toUpperCase().replaceAll('-', ''),
  });
  const inviter = await db.user.create({ data: userInput('invite-owner') });
  const invitee = await db.user.create({ data: userInput('invite-guest') });
  await db.referral.create({ data: { inviterUserId: inviter.id, inviteeUserId: invitee.id } });
  await expect(
    db.referral.create({ data: { inviterUserId: inviter.id, inviteeUserId: invitee.id } }),
  ).rejects.toMatchObject({ code: 'P2002' });
});
```

- [ ] **Step 2: Run the test to verify it fails because the generated client has no models**

Run: `cd viviai-server && npm test -- test/integration/account-schema.test.ts`
Expected: FAIL with missing `referral`/schema properties.

- [ ] **Step 3: Add the Prisma models and explicit constraints**

Use UUID primary keys, `Timestamptz(6)` timestamps, mapped snake-case table names, and these uniqueness rules:

```prisma
model Notification {
  id        String    @id @default(uuid()) @db.Uuid
  userId    String    @map("user_id") @db.Uuid
  type      String
  title     String
  body      String
  action    Json?
  readAt    DateTime? @map("read_at") @db.Timestamptz(6)
  createdAt DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@index([userId, readAt, createdAt])
  @@map("notifications")
}

model Referral {
  id            String    @id @default(uuid()) @db.Uuid
  inviterUserId String    @map("inviter_user_id") @db.Uuid
  inviteeUserId String    @unique @map("invitee_user_id") @db.Uuid
  status        String    @default("pending")
  rewardCredits Int       @default(100) @map("reward_credits")
  qualifiedAt   DateTime? @map("qualified_at") @db.Timestamptz(6)
  rewardedAt    DateTime? @map("rewarded_at") @db.Timestamptz(6)
  createdAt     DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  @@index([inviterUserId, createdAt])
  @@map("referrals")
}
```

Add foreign keys for both referral users, one-to-one avatar ownership, campaign/code/claim relations, campaign validity fields, code digest uniqueness, and claim uniqueness on `[userId, codeId]` plus `idempotencyKey`.

- [ ] **Step 4: Write the SQL migration including a safe invite-code backfill**

Backfill existing users with a deterministic uppercase code derived from UUID text before adding `NOT NULL` and `UNIQUE`. Add check constraints for non-negative credits, limits, and usage counts.

- [ ] **Step 5: Regenerate Prisma and rerun the test**

Run: `cd viviai-server && npm run prisma:generate && npm test -- test/integration/account-schema.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit the schema slice**

```bash
git add viviai-server/prisma/schema.prisma viviai-server/prisma/migrations/20260912010000_account_engagement viviai-server/test/helpers/database.ts viviai-server/test/integration/account-schema.test.ts
git commit -m "feat(server): persist account engagement data"
```

### Task 2: Extract purpose-bound email challenges and add account commands

**Files:**
- Create: `viviai-server/src/modules/identity/challenge.service.ts`
- Create: `viviai-server/src/modules/account/account.module.ts`
- Create: `viviai-server/src/modules/account/account.controller.ts`
- Create: `viviai-server/src/modules/account/account.service.ts`
- Modify: `viviai-server/src/modules/identity/identity.service.ts`
- Modify: `viviai-server/src/modules/identity/identity.controller.ts`
- Modify: `viviai-server/src/modules/identity/identity.module.ts`
- Modify: `viviai-server/src/modules/identity/identity.controller.ts`
- Modify: `viviai-server/src/modules/identity/identity.module.ts`
- Modify: `viviai-server/src/app.module.ts`
- Test: `viviai-server/test/integration/account.test.ts`
- Test: `viviai-server/test/integration/identity.test.ts`

**Interfaces:**
- Produces: `EmailChallengeService.send(email, purpose)` and `consume(email, purpose, code, transactionAction)`.
- Produces: `AccountService.updateProfile`, `changeEmail`, `changePassword`, and `publicAccount`.
- Consumes: `WalletService.balance`, `IdentityService.createSession`, and `SessionGuard`.

- [ ] **Step 1: Write failing tests for profile and security commands**

Cover username uniqueness, `change-email` purpose isolation, `change-password` purpose isolation, password length, session revocation, and user-scoped responses:

```ts
const changed = await http.patch('/api/account/profile', cookie, { username: 'new_name' });
expect(changed.status).toBe(200);
expect(changed.body.data).toMatchObject({ username: 'new_name', inviteCode: expect.any(String) });
expect(changed.body.data).not.toHaveProperty('passwordHash');
```

- [ ] **Step 2: Run the focused tests and confirm 404/validation failures**

Run: `cd viviai-server && npm test -- test/integration/account.test.ts test/integration/identity.test.ts`
Expected: FAIL because `/api/account/*` and new challenge purposes do not exist.

- [ ] **Step 3: Move challenge generation and consumption into `EmailChallengeService`**

Define the exact purpose type and keep consume plus mutation in one transaction:

```ts
export type ChallengePurpose =
  | 'register'
  | 'reset-password'
  | 'change-email'
  | 'change-password';

async consume<T>(
  email: string,
  purpose: ChallengePurpose,
  code: string,
  action: (tx: DbTransaction) => Promise<T>,
): Promise<T>;
```

Retain scrypt hashing, five-attempt maximum, advisory locking, 60-second resend delay, and mail failure behavior from `IdentityService`.

- [ ] **Step 4: Implement authenticated account commands**

Use strict Zod schemas. `changeEmail(userId, { email, code })` consumes a challenge for the new email, checks uniqueness, updates the user, and deletes all sessions except the request's current token hash. `changePassword` consumes a challenge for the current login email, hashes the new password, and applies the same session policy.

Return one DTO shape from login, `/me`, and account commands:

```ts
export interface AccountDto {
  id: string;
  username: string;
  email: string;
  avatarUrl?: string;
  planId: 'free';
  planName: 'Free';
  credits: number;
  frozenCredits: number;
  concurrency: number;
  inviteCode: string;
}
```

- [ ] **Step 5: Rerun identity and account tests**

Run: `cd viviai-server && npm test -- test/integration/account.test.ts test/integration/identity.test.ts`
Expected: PASS, including existing register/reset tests.

- [ ] **Step 6: Commit account commands**

```bash
git add viviai-server/src/modules/identity viviai-server/src/modules/account viviai-server/src/app.module.ts viviai-server/test/integration/account.test.ts viviai-server/test/integration/identity.test.ts
git commit -m "feat(server): add authenticated account commands"
```

### Task 3: Add secure avatar upload

**Files:**
- Modify: `viviai-server/src/modules/account/account.controller.ts`
- Modify: `viviai-server/src/modules/account/account.service.ts`
- Modify: `viviai-server/src/modules/assets/assets.module.ts`
- Modify: `viviai-server/src/modules/assets/assets.service.ts`
- Test: `viviai-server/test/integration/account-avatar.test.ts`

**Interfaces:**
- Produces: `POST /api/account/avatar` multipart endpoint returning `AccountDto`.
- Consumes: existing `validateImage`, `ObjectStore`, and private asset content route.

- [ ] **Step 1: Write failing tests for a valid avatar and invalid ownership/content**

```ts
const response = await upload('/api/account/avatar', cookie, fixturePng('avatar.png'));
expect(response.status).toBe(201);
expect(response.body.data.avatarUrl).toMatch(/^\/api\/assets\/[0-9a-f-]+\/content$/);
```

Also assert non-images return `400 ASSET_INVALID`, files over 1 MiB return `413`, and replacing an avatar never reassigns another user's asset.

- [ ] **Step 2: Run the avatar test to verify failure**

Run: `cd viviai-server && npm test -- test/integration/account-avatar.test.ts`
Expected: FAIL with route not found.

- [ ] **Step 3: Implement upload using the existing storage abstraction**

Create an `Asset` with `source: 'upload'`, verified dimensions and digest, then set `User.avatarAssetId` in the same database transaction. Do not accept `avatarUrl` from JSON and do not expose the storage object key.

- [ ] **Step 4: Rerun avatar and asset regression tests**

Run: `cd viviai-server && npm test -- test/integration/account-avatar.test.ts test/integration/assets.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit avatar upload**

```bash
git add viviai-server/src/modules/account viviai-server/src/modules/assets viviai-server/test/integration/account-avatar.test.ts
git commit -m "feat(server): add private account avatars"
```

### Task 4: Implement notifications, referrals, and idempotent redemption

**Files:**
- Create: `viviai-server/src/modules/engagement/engagement.module.ts`
- Create: `viviai-server/src/modules/engagement/engagement.controller.ts`
- Create: `viviai-server/src/modules/engagement/notification.service.ts`
- Create: `viviai-server/src/modules/engagement/referral.service.ts`
- Create: `viviai-server/src/modules/engagement/redemption.service.ts`
- Modify: `viviai-server/src/modules/identity/identity.service.ts`
- Modify: `viviai-server/src/modules/wallet/wallet.service.ts`
- Modify: `viviai-server/src/app.module.ts`
- Test: `viviai-server/test/integration/engagement.test.ts`
- Test: `viviai-server/test/integration/redemption-races.test.ts`

**Interfaces:**
- Produces: `NotificationService.create`, `list`, `markRead`, and `markAllRead`.
- Produces: `ReferralService.bindAtRegistration` and `listForInviter`.
- Produces: `RedemptionService.claim(userId, code, idempotencyKey)`.

- [ ] **Step 1: Write failing notification/referral/redemption tests**

Assert user isolation, idempotent read operations, optional invite-code binding during registration, rejection of self/unknown invite codes, one inviter per invitee, immediate idempotent rewards for both users after successful registration, concurrent redemption limits, duplicate idempotency replay, wallet balance change, and notification creation.

- [ ] **Step 2: Run tests and confirm missing service failures**

Run: `cd viviai-server && npm test -- test/integration/engagement.test.ts test/integration/redemption-races.test.ts`
Expected: FAIL because the module and routes are absent.

- [ ] **Step 3: Implement user-scoped notification and referral routes**

Expose:

```text
GET  /api/notifications
POST /api/notifications/:id/read
POST /api/notifications/read-all
GET  /api/invites
```

Return notification `body` as frontend `content`, action `href` only when it is a safe internal path, and referral status only as `pending` or `rewarded`.

- [ ] **Step 4: Implement redemption under wallet and code locks**

Within one transaction, acquire stable advisory locks for the user and code, validate campaign/code time and limits, create a unique claim, issue a credit lot with `sourceId: redeem:<claimId>`, increment usage, and create a credits notification. A replay with the same key returns the previous account DTO; a different payload for the same key returns `409 IDEMPOTENCY_CONFLICT`.

Extend registration input with optional `inviteCode`. After the new user is created but before the registration transaction commits, call `ReferralService.bindAtRegistration(tx, userId, inviteCode)`. A valid code creates a rewarded referral, issues `invite:inviter:<referralId>` and `invite:invitee:<referralId>` credit lots, and creates notifications for both users. No code leaves registration unchanged; an unknown/self code returns `422 INVALID_INVITE_CODE` and rolls back account creation.

- [ ] **Step 5: Rerun engagement, wallet, and race tests**

Run: `cd viviai-server && npm test -- test/integration/engagement.test.ts test/integration/redemption-races.test.ts test/integration/wallet.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit engagement services**

```bash
git add viviai-server/src/modules/engagement viviai-server/src/modules/identity/identity.service.ts viviai-server/src/modules/identity/identity.controller.ts viviai-server/src/modules/identity/identity.module.ts viviai-server/src/modules/wallet/wallet.service.ts viviai-server/src/app.module.ts viviai-server/test/integration/engagement.test.ts viviai-server/test/integration/redemption-races.test.ts
git commit -m "feat(server): add notifications referrals and redemption"
```

### Task 5: Connect account, notification, and invite pages to real APIs

**Files:**
- Modify: `viviai-web/src/services/api.ts`
- Modify: `viviai-web/src/services/queryKeys.ts`
- Modify: `viviai-web/src/types/domain.ts`
- Modify: `viviai-web/src/features/account/AccountPage.tsx`
- Modify: `viviai-web/src/features/notifications/NotificationSheet.tsx`
- Modify: `viviai-web/src/features/invite/InvitePage.tsx`
- Modify: `viviai-web/src/features/auth/AuthPage.tsx`
- Modify: `viviai-web/src/app/routes.tsx`
- Test: `viviai-web/src/services/api.test.ts`
- Test: `viviai-web/src/features/account/AccountPage.test.tsx`
- Test: `viviai-web/src/app/routes.test.tsx`
- Create: `viviai-web/src/features/notifications/NotificationSheet.test.tsx`
- Create: `viviai-web/src/features/invite/InvitePage.test.tsx`
- Create: `viviai-web/src/features/auth/InviteRegistration.test.tsx`

**Interfaces:**
- Consumes: all APIs from Tasks 2–4.
- Produces: `api.uploadAvatar`, expanded `sendCode`, `markAllNotificationsRead`, and idempotent `redeemCode`.

- [ ] **Step 1: Write failing API and page tests in real mode**

Assert exact paths, multipart avatar requests, `Idempotency-Key` for redemption, code-purpose requests, enabled controls, notification loading, mark-all behavior, an accessible `/invite` route without `RealApiUnavailablePage`, and forwarding `?invite=CODE` during registration.

- [ ] **Step 2: Run focused frontend tests**

Run: `cd viviai-web && npm test -- src/services/api.test.ts src/features/account/AccountPage.test.tsx src/features/notifications/NotificationSheet.test.tsx src/features/invite/InvitePage.test.tsx src/features/auth/InviteRegistration.test.tsx src/app/routes.test.tsx`
Expected: FAIL on disabled real-mode controls and missing API methods.

- [ ] **Step 3: Update the API client and domain errors**

Use the server paths exactly and add:

```ts
sendCode(email: string, purpose: 'register' | 'reset-password' | 'change-email' | 'change-password')
uploadAvatar(file: File): Promise<User>
markAllNotificationsRead(): Promise<{ updated: number }>
redeemCode(code: string, idempotencyKey: string): Promise<User>
register(input: { username: string; email: string; password: string; code: string; inviteCode?: string }): Promise<User>
```

- [ ] **Step 4: Replace data-URL avatar and Mock-only warnings**

Store the selected `File`, show a local object-URL preview, upload on save, revoke the preview URL on cleanup, add “发送验证码” actions for email/password, and derive the redemption success amount from the ledger/account response instead of hardcoding `100`.

- [ ] **Step 5: Enable notification and invite queries in real mode**

Remove `enabled: open && !isRealApi()` and the invite route gate. Add empty, loading, retry, unread count, mark-one, and mark-all states. Keep all links internal. In `AuthPage`, read `invite` with `URLSearchParams`, validate the same code character policy as the API, and include it only in registration requests.

- [ ] **Step 6: Rerun focused tests and frontend quality checks**

Run: `cd viviai-web && npm test -- src/services/api.test.ts src/features/account/AccountPage.test.tsx src/features/notifications/NotificationSheet.test.tsx src/features/invite/InvitePage.test.tsx src/features/auth/InviteRegistration.test.tsx src/app/routes.test.tsx && npm run lint`
Expected: PASS.

- [ ] **Step 7: Commit user frontend integration**

```bash
git add viviai-web/src/services viviai-web/src/types/domain.ts viviai-web/src/features/account viviai-web/src/features/notifications viviai-web/src/features/invite viviai-web/src/features/auth/AuthPage.tsx viviai-web/src/features/auth/InviteRegistration.test.tsx viviai-web/src/app/routes.tsx viviai-web/src/app/routes.test.tsx
git commit -m "feat(web): connect account and engagement APIs"
```

### Task 6: Verify the account and engagement vertical slice

**Files:**
- No planned file changes; a failure returns execution to the task that owns the failing behavior.

**Interfaces:**
- Verifies: migration, API contract, browser state persistence, security regressions, and payment non-regression.

- [ ] **Step 1: Apply migrations to the test database**

Run: `cd viviai-server && npm run prisma:migrate`
Expected: `20260912010000_account_engagement` applied successfully.

- [ ] **Step 2: Run the complete backend suite**

Run: `cd viviai-server && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Run the complete user frontend suite**

Run: `cd viviai-web && npm test && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 4: Run the existing backend smoke test**

Run: `cd viviai-server && npm run smoke`
Expected: health, identity, generation, asset, wallet, and payment-regression checks pass.

- [ ] **Step 5: Confirm the slice is clean after verification**

Run: `git status --short`
Expected: no uncommitted files created by this plan; pre-existing user-owned untracked files may remain and must not be staged.
