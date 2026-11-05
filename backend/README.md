# Backend setup

## Requirements

- Node.js 20 or newer
- A Neon PostgreSQL database

Copy `.env.example` to `.env` and set `DATABASE_URL` from Neon and a private `BETTER_AUTH_SECRET` of at least 32 characters. Keep `.env` out of version control. `BETTER_AUTH_URL` is the backend origin and `FRONTEND_URL` is the allowed frontend origin.

```bash
npm ci
npm run db:check
npm run db:generate
npm run db:migrate
npm run start:dev
```

Drizzle migrations are generated in `drizzle/`. Review generated SQL before applying it to a shared or production database. Better Auth is mounted at `/api/auth`; email and password signup creates patient accounts by default. The role field is server-managed.

The minimal `db:check` command runs `select 1` and reports connection status without printing credentials or database details.

## Appointment reminders

The backend persists reminders in `appointment_reminder` and polls due jobs every 10 seconds. The default intervals are 24 hours and 1 hour before the appointment. Intervals already in the past are skipped when the appointment becomes scheduled. Rescheduling replaces the pending jobs; cancellation and completion cancel them. The worker rechecks appointment status, time, schedule version, and participant eligibility immediately before delivery. Recipient address and message names are snapshotted so provider retries reuse the same idempotent payload; reminders are cancelled if the email address changes. Sent reminder rows are retained for 30 days; cancelled and dead rows for 90 days. Overdue jobs are recovered from PostgreSQL after a backend restart, but are cancelled once the appointment has started.

The reminder worker currently accepts delivery only when `EMAIL_DELIVERY_MODE=test` is configured with `EMAIL_TEST_RECIPIENT` and valid Resend test credentials. It routes all reminder messages to that sink address. Production reminder delivery is intentionally paused; enabling it for real recipients requires a separately reviewed change. The worker uses 10-second polling, two-minute processing leases, up to 8 attempts, and exponential retry delays capped at 15 minutes. Permanently rejected messages and exhausted attempts are marked `dead` for inspection.

### Local reminder test procedure

1. Install dependencies with `npm ci`.
2. Run the focused automated tests with `npm test -- src/notifications/appointment-reminder.service.spec.ts src/notifications/email-templates.spec.ts` (tests mock the database/provider and never send email).
3. For a local integration run, configure only a test Resend key, `EMAIL_DELIVERY_MODE=test`, and an `EMAIL_TEST_RECIPIENT` sink address in your local environment. Do not use production credentials or production delivery mode for reminder verification.

### Migration

The reminder schema is introduced by `drizzle/0010_appointment_reminders.sql`, immutable retry payload fields by `drizzle/0011_reminder_payload_snapshot.sql`, and the retention index by `drizzle/0012_reminder_retention_index.sql`; each has generated metadata in `drizzle/meta/` and a journal entry. Review and apply them in order to the intended development database using the normal migration workflow. This implementation step does not apply migrations; do not start the reminder worker against a database until the migrations are applied.
