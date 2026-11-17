# Patient check-in and queue release review

Phase 6 adds integration and release verification. This document is a release gate,
not evidence that production is ready. No database migration or deployment is
performed by the local verifier.

## Recorded local result — 16 November 2026

The full verifier passed on the uncommitted Phases 1–6 working tree based on
commit `0653024`: 614 backend tests across 54 files, 185 frontend tests, both
production builds, both linters (existing warnings, no errors), and the isolated
Chromium workflow. This result is not a production deployment or live database
validation. Phase 6 adds three files: this review, the local verifier and
`backend/src/appointments/appointment-queue.integration.spec.ts`.

## Database verification result — 16 November 2026

After explicit authorization, the separate Neon test endpoint
`ep-noisy-haze-b54uvdmu` was migrated through 0019. It initially had only migrations
0000–0015. The confirmed application endpoint `ep-gentle-morning-b5hep6jt`, database
`neondb`, already had 0016–0017 and received only 0018–0019. Both targets now have
the staff role and all three new tables. The new columns/nullability, 10 valid
indexes and 41 validated constraints (including PostgreSQL not-null constraints)
were checked against the 0019 snapshot. Application user, appointment, payment and
refund counts were unchanged by the migration.

Historical migration 0013–0015 hashes differed only by LF/CRLF encoding. Applied
0016–0017 SQL hashes also matched, but their historical ledger timestamps differed
from the local journal. To avoid replaying existing tables, Drizzle received a
temporary migration directory containing only verified pending migrations for
each target. Source migration files and existing ledger entries were not edited.
New ledger entries for 0018–0019 were verified after application.

`backend/scripts/verify-queue-live.mjs` passed on the test branch using the actual
compiled services and PostgreSQL transactions. It checked dedicated staff
provisioning/assignment, concurrent duplicate and distinct check-ins, stable token
allocation and waiting order, own attendance and cross-account denial, concurrent
start-next (one success, one conflict), consultation completion, cancellation and
position updates without renumbering, revoked access and no-show failure when
configuration is absent. All dedicated fixture accounts and appointments were
removed afterward. No production workflow records or real payments were created.

To repeat on the disposable branch after building the backend:

```powershell
cd backend
npm run build
node scripts/verify-queue-live.mjs
```

The script validates the separate test endpoint before importing application
services; it refuses to use the application database endpoint. Its temporary
accounts are named with a unique `queueverify-` prefix. It suppresses email and
does not initialize payment or notification integrations. This is a fourth
verification file, keeping the total verification scope below eight files.

The approved no-show grace period is **15 minutes**. Local `backend/.env` and the
environment example now specify `QUEUE_NO_SHOW_GRACE_MINUTES=15`.
The database-backed verifier passed again with this value: no-show was denied at
14 minutes, allowed at 16 minutes, and repeat requests preserved attendance
without allocating a token or cancelling the booking. Dedicated fixtures were
removed after the run.
Set the same backend environment variable in Render when deploying the feature;
local environment changes do not change Render configuration.

Still pending: deploy reviewed application code with the 15-minute setting and
exercise real authenticated dashboards end to end. Database-backed service verification
does not establish that Vercel/Render are running this uncommitted code.

## Local verification

From the repository root, run:

```powershell
node backend/scripts/verify-queue-release.mjs
```

Requires installed backend/frontend dependencies and Chromium/Chrome for the existing
browser fixture. It runs the complete backend test suite, backend build/lint,
all top-level frontend unit tests, frontend build/lint, then the browser workflow.
It stops on the first failed command. Builds write generated output. The Next.js
browser fixture may regenerate `frontend/AGENTS.md`; inspect that diff before any
commit. The command does not commit, push, migrate, deploy or intentionally contact
a live database. API, payment and speech browser interactions use local fixtures.

The new HTTP integration tests use real Nest routes, guards, input validation and
queue service orchestration with fixture persistence and sessions. They verify
check-in retries do not allocate a second token; the owning patient and doctor see
the same attendance; revoked staff cannot retry or read; cross-account reads fail;
and stale pagination/client token injection cannot write. These tests do **not**
prove PostgreSQL locking, constraints or production session behavior.

Existing suites cover lifecycle transitions, cancellation/refund integration,
payment reconciliation, timezone rules, frontend polling and chatbot behavior.
The browser suite covers doctor check-in/start/completion, patient status, staff
provisioning/assignment/revocation, redirects and existing chatbot/payment/voice UI.

## Database gate procedure (application completed; retained for repeat releases)

1. Confirm the intended Neon project, branch and database against Render's actual
   connection target without displaying credentials. Take a recoverable backup or
   branch before any approved change. Identify the exact deployed code revision.
2. Read the production migration ledger and actual schema. Reconcile the full
   migration chain before running the migration tool; do not infer readiness from
   a single missing column or manually mark migrations applied.
3. In a disposable database first, verify existing migrations through `0017`, then
   `0018_staff_access` and `0019_patient_queue`, using the repository's Drizzle
   configuration and migration mechanism. Check enum transaction compatibility,
   the staff assignment foreign keys, composite queue FK, daily uniqueness,
   token uniqueness, one current patient per doctor, attendance state checks and
   waiting-order index. Do not rerun partially applied SQL blindly.
4. After separate approval, apply the verified sequence to the intended target.
   Capture ledger/schema evidence. Do not run migrations from the frontend or
   concurrently from multiple application instances.
5. Configure `QUEUE_NO_SHOW_GRACE_MINUTES=15`, the explicitly approved business
   value. Unconfigured no-show actions deliberately fail closed. Confirm the
   deployed backend has this value; the local `.env` does not configure Render.

## Acceptance checklist (see recorded evidence and remaining items above)

Use dedicated test accounts and appointments, never real patient records or real
payments. Record expected/actual results and the deployed revision.

| Scenario | Required result |
| --- | --- |
| Simultaneous duplicate check-ins | One attendance row, one token consumed, same returned token/time |
| Simultaneous different check-ins | Unique daily tokens; waiting positions follow appointment start, then check-in time, then appointment ID |
| Concurrent start-next calls | One current patient for the doctor; stale request conflicts safely |
| Concurrent cancellation and check-in/start | Consistent terminal/active state; no orphan attendance; token never reused |
| Staff assignment revoked during action | Authorized transaction completes or denied request fails; later requests cannot access queue |
| Doctor completion | Attendance and booking complete atomically; next waiting positions update |
| Cancellation/refund/payment retry | Existing payment/refund rules preserved; no duplicate charge/refund or resurrection of attended booking |
| No-show after approved grace | Explicit action only; no token allocated, no automatic cancellation/refund; reminders stop |
| Local midnight and DST | Doctor-local service date, correct day bounds, stable historical queue timezone |
| Unauthorized patient/staff/doctor | Cannot view another patient's attendance or an unassigned doctor's queue |
| Reload/network failure/two tabs | Polling recovers, stale state disables unsafe actions, no duplicate writes |
| Chatbot and booking | Existing booking/payment/history and language/voice flows remain functional |

Verify patient, doctor, staff and admin dashboards on mobile and desktop with real
sessions. Verify check-in time, token, current patient and waiting list agree across
dashboards. Verify expired sessions clear access and require signing in again.

## Release and recovery

Release remains blocked until the deployed backend has the approved no-show configuration and live
checks pass. Review the logical PR diffs independently of the accumulated
uncommitted working tree; Phase 6 must remain within 8 changed files. Do not merge
or publish based on local tests alone.

If verification fails, stop rollout and retain evidence without secrets. Prefer an
application rollback compatible with the additive schema; do not drop queue tables,
remove enum values or erase attendance/history as a rollback shortcut. Review
database repair separately before any mutation.
