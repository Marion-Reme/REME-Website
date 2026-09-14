# REME Painting Group Work Orders

A secure work-order management MVP for Australian construction maintenance and trade subcontracting teams. Managers capture scope and pricing, assign and schedule work, then review field evidence. Workers receive only their own operational tasks, with no pricing fields, financial documents or full audit values.

## Architecture

- Next.js 16 App Router, React 19, TypeScript and Tailwind CSS
- Supabase Postgres 16, Auth, MFA and Row Level Security
- Cloudflare R2 private object storage with short-lived, object-scoped signed URLs
- Resend email and Twilio SMS adapters, dispatched by a protected cron endpoint
- Cloudflare Workers hosting through OpenNext, with Git-based deploys and a native Cron Trigger
- Vitest, pgTAP and Playwright test harnesses

Operational and financial data are physically separated. `task` and `work_order` contain worker-safe information. `task_pricing`, `work_order_totals`, `extraction_result` and full `audit_event` values are manager-only under RLS. Worker pages query explicit `worker_task_safe` and `worker_job_safe` allowlist views.

## Local setup

Requirements: Node 22+, pnpm 11+, Docker Desktop and the Supabase CLI.

```bash
cp .env.example .env.local
supabase start
supabase db reset
pnpm install
pnpm dev
```

Open `http://localhost:3000`. Copy the local Supabase URL and publishable/secret keys printed by `supabase status` into `.env.local`. For photo uploads, create a private R2 bucket and add its S3 credentials. R2 bucket CORS must allow `PUT` and `GET` from the local and production app origins and allow the `Content-Type` header. A starting policy is in `infrastructure/r2-cors.json`.

## Create the first manager

There is no public sign-up. After migrations are applied:

```bash
read -s "MANAGER_PASSWORD?Manager password: "; echo
MANAGER_PASSWORD="$MANAGER_PASSWORD" pnpm seed:manager --email manager@example.com --name 'Manager Name' --tenant 'Company Name'
unset MANAGER_PASSWORD
```

Sign in with that account. Because manager MFA is required by default, REME Work Orders immediately walks the manager through TOTP authenticator enrolment. Optionally load the sample Bentino-style order:

```bash
pnpm seed:sample
```

Workers are created only from **Manager -> Workers -> Invite a worker**.

## Environment

See `.env.example`. Required for the core application:

- `NEXT_PUBLIC_APP_URL`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SECRET_KEY` (server only, never expose it with a `NEXT_PUBLIC_` prefix)

Required for photos:

- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`

Required for outbound delivery:

- `RESEND_API_KEY`, `RESEND_FROM`
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`
- `CRON_SECRET` (32+ random characters)

Email and SMS failures do not block in-app notifications. The dispatcher retries failed deliveries up to five times. Notification text is deliberately amount-free.

## Database migrations

Migrations are ordered in `supabase/migrations`:

1. tenant, identity and worker foundation
2. clients, customers, sites and contacts
3. trade categories and tenant seeding
4. work orders, trade sections and tasks
5. isolated pricing and totals
6. assignments, schedules and worker ownership policies
7. status history and work-order roll-up
8. completions, notes, attachments and photos
9. append-only audit events
10. notifications and future PDF draft tables
11. transactional RPCs and worker-safe views
12. retention and soft deletion

Run `supabase db reset` locally or `supabase db push` against a linked project. Never enter real customer or financial data until the RLS test, MFA and backup restore checks pass.

## Useful commands

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
pnpm build:cloudflare
pnpm preview:cloudflare
pnpm test:e2e
```

Database policy tests run with `supabase test db`. End-to-end tests require a migrated test project and seeded manager/worker accounts. The static pricing-leak suite runs without external services and fails if financial fields reach worker source or safe views.

## Deployment

1. Create and link a Supabase project, apply migrations, disable public sign-up and configure the production redirect URL.
2. Create a private R2 bucket, credentials restricted to that bucket and production CORS.
3. Follow [CLOUDFLARE.md](CLOUDFLARE.md) once to connect `danielb56/Marions` and configure build/runtime variables. Every subsequent push to `main` deploys automatically.
4. Add a random 32+ character `CRON_SECRET` as a Worker secret. Cloudflare dispatches queued notifications every five minutes through the native Cron Trigger.
5. Configure Resend and Twilio credentials, verify the sender/domain, then enable SMS in Manager settings.
6. Enable Supabase PITR. Schedule `scripts/backup.sh` weekly with a database URL and independent R2 backup credentials, then test a restore.

## Current MVP boundaries

- Work-order intake is manual with a paste helper. PDF extraction and email-in are intentionally deferred.
- Scheduling is form-based; drag-and-drop is deferred.
- Photo retries survive connectivity loss, but a partially transferred file restarts rather than resuming at a byte offset. Photos are client-downscaled, re-encoded and EXIF-free before upload.
- Geocoding is not automatic. Map links use the entered address.
- Original-PDF schema and secure download path exist, but manual-entry MVP has no PDF-upload screen.
- A production restore drill, provider deliverability test and mobile browser E2E run require the owner’s external credentials and devices.

## Removing a disabled worker

Apply migration `0024_remove_disabled_worker.sql` before deploying the removal UI.
Managers can open **Workers**, disable an account, then expand **Remove worker**
and confirm permanent removal. Auth soft deletion removes sign-in credentials
irreversibly while retaining the identity needed by assignments, photos and audit
history. A database trigger marks the profile removed in the same transaction,
releases its email for future invitations and prevents reactivation. Removed
accounts are hidden from Workers and Team access; existing work records remain.
Open work must still be reassigned by a manager.
