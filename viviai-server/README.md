# VIVIAI server

This directory is the phase-A backend foundation. It provides a NestJS API runtime, real accounts and cookie sessions, private image uploads, PostgreSQL/Prisma migrations, object-store adapters, and a real-database integration harness. Jobs, wallet accounting, providers, workers, payments, subscriptions, community features, and workflow runs are not implemented yet. The existing frontend is not connected to this API.

## Requirements

- Node.js 22 LTS (developed with 22.22.2)
- PostgreSQL
- Redis (provisioned for later worker tasks; Task 1 does not read it yet)
- Optional private S3-compatible storage; local filesystem storage is development/test only

Install exact locked dependencies. `--legacy-peer-deps` is required because npm 10's peer auto-resolution follows optional Vite development-tool peers into a conflicting Vitest major on this dependency set.

```bash
npm ci --legacy-peer-deps --cache /private/tmp/viviai-npm-cache --no-audit --no-fund
cp .env.example .env
```

Load `.env` through your process manager or shell; this service intentionally does not silently load environment files.

## Local services and database

Start PostgreSQL and Redis with Compose. Add `--profile s3` to start optional MinIO development storage.

```bash
docker compose up -d postgres redis
docker compose --profile s3 up -d
npm run prisma:migrate
```

To use existing task-owned native services instead, set `DATABASE_URL` and `REDIS_URL` explicitly. Never point integration tests at a database role that may not create and drop its own schemas.

Run the API:

```bash
npm run dev
```

The default bind address is `127.0.0.1:3001`. The factory `createApp(configOverrides?)` initializes a Nest application but never listens; only the executable entrypoint calls `listen`.

## HTTP boundary

- `GET /api/health` is a liveness check.
- `GET /api/health/ready` checks PostgreSQL and returns `503 DATABASE_UNAVAILABLE` on failure.
- Successful responses use `{ "data": ..., "message": "ok", "requestId": "..." }`.
- Errors use `{ "data": null, "message": "...", "requestId": "...", "code": "..." }` so the current frontend receives the stable code directly.
- Credentialed CORS accepts only configured explicit origins. JSON and form bodies default to `1mb` limits.
- All unsafe HTTP requests require an `Origin` exactly matching `CORS_ORIGINS`, including login and registration. Sessions use HttpOnly, SameSite=Lax cookies, Secure in production, expiring after 30 days; only token hashes are stored.
- Auth routes: `POST /api/auth/send-code`, `/register`, `/login`, `/logout`, `/reset-password` and `GET /api/me`. Send-code takes `{email,purpose}`; purpose is `register` (default) or `reset-password`. Codes expire in 10 minutes, allow five attempts and have a 60-second resend cooldown. Durable per-credential and per-IP rate limits apply across app instances.
- Development mail is written only to `DEV_MAILBOX_ROOT` (directory mode 0700, files 0600); no SMTP is used while development mail is enabled. Production requires `SMTP_URL` and `MAIL_FROM` with development mail disabled.
- Phase A requires login before `POST /api/remix-references`. Upload multipart `file` (JPEG/PNG/WebP, at most 5 MiB and 40 million decoded pixels, single frame). Client width/height and userId are ignored. Images are re-encoded as PNG after orientation and metadata stripping.
- Private asset APIs: `GET /api/assets` (array, at most 200 newest; optional `favorite=true/false`, `deleted=true/false`), `GET /api/assets/:id`, `GET /api/assets/:id/content`, `PATCH /api/assets/:id` (`name`/`favorite`), `DELETE /api/assets/:id`, `POST /api/assets/:id/restore`. Every operation verifies owner identity. Soft-deleted images can be restored for seven days; no physical deletion job runs in this phase.
- Manual account seed: set `NODE_ENV=development`, `DEV_SEED_EMAIL`, `DEV_SEED_USERNAME`, and a private `DEV_SEED_PASSWORD` (12–128 characters), then run `npm run seed:dev`. It fails if credentials are absent or an account already exists and never changes existing passwords. Accounts have no paid plan and zero credits until the wallet task supplies grants.

Production startup validation rejects simulation providers, local storage, and development mail, including overrides supplied to the application factory. S3 storage requires a bucket and region; static access-key credentials must be supplied as a complete pair or omitted when workload identity supplies them. Object keys are server-owned logical keys, never client filesystem paths. Local bytes are stored under the private configured root with containment/symlink checks, file and directory synchronization, and atomic rename; S3 writes use the official SDK without a public ACL.

The local driver is a development/test convenience for a trusted single-host storage root. Processes outside VIVIAI that can replace directories or symlinks inside that root are outside its portable trust boundary; production must use the S3 driver.

## Tests

Tests require a task-owned PostgreSQL database. Each suite creates a cryptographically namespaced `viviai_test_*` schema, applies real migrations, and drops only the schema that the current database user owns. The harness refuses any non-test schema name.

```bash
DATABASE_URL=postgresql://viviai@127.0.0.1:55432/viviai_dev \
REDIS_URL=redis://127.0.0.1:56379 \
npm test -- test/integration/runtime.test.ts

npm run build
```

## Locked foundation versions

- NestJS 12.0.1
- Prisma CLI/client/PostgreSQL adapter 7.10.0 (matched stable release; Prisma 8 was release-candidate-only during implementation)
- PostgreSQL driver 8.23.0
- AWS SDK S3 client 3.1127.0
- Zod 4.5.4
- Vitest 4.1.11 with Vite 7.3.6
- TypeScript 7.0.2; Node 22 types 22.20.1
