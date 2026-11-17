# Booking tokens and reception queue

## Behavior

- Creating an appointment hold reserves a token in the same transaction as the booking. Payment is still required before check-in.
- Tokens are unique for a doctor and local service date. Cancelled and expired bookings do not return their numbers to the counter; gaps are expected.
- Payment confirmation and retries reuse the token. Rescheduling within the same service date keeps the token; moving to another date reserves a number in the new daily queue.
- Staff/doctor check-in copies the reserved token into attendance. It never allocates a replacement token. Before check-in there is no waiting position.
- Waiting positions and Start next patient use the same check-in-time order, with appointment ID as a deterministic tie-breaker. Position changes as consultations start or patients leave the queue.
- The patient dashboard and booking confirmation show the token and explain when a position becomes available. Now serving exposes only a token, not another patient's identity.

## Reception workspace

The staff dashboard has arrivals, waiting and closed-visit views, a pinned current consultation, summary cards, and search by patient name or exact token (with or without #). Search applies only to the loaded page; pagination remains available for more records. Check-in receipts confirm the retained token and assigned position. Only doctors can start/complete consultations.

## Required database update

Migration `backend/drizzle/0021_booking_tokens.sql` and its generated snapshot/journal entry add a booking-token table and change the waiting-order index. The migration copies existing attendance tokens unchanged, assigns unused tokens to scheduled bookings and unexpired unpaid holds, and advances daily counters. It does not create attendance, check-in times or positions, or change booking/payment/refund records.

Apply through the existing verified Drizzle migration process, first on the disposable test database. Reconcile the actual migration ledger before applying; this project has previously documented historical ledger timestamp differences in `QUEUE_RELEASE_REVIEW.md`. Do not replay old migrations or edit their applied ledger entries.

Pause old booking/check-in writers before migrating, then start the updated backend. Do not run old and new queue writers concurrently: old code allocates a token on arrival. All workers handling payment capture, expiry and rescheduling must use the updated code. Existing live waiting patients will follow check-in order after this release.

After migration and a backend build, `node backend/scripts/verify-queue-live.mjs` (run from the backend directory as `node scripts/verify-queue-live.mjs`) verifies the workflow on the explicitly configured disposable database. It refuses the application database and cleans up only its dedicated fixtures. Then verify authenticated patient, doctor and staff screens before rollout.

## Local verification

Both production builds and focused queue tests passed. The wider backend run passed 603 tests; 15 HTTP tests were blocked by the environment denying loopback connections (`EACCES`). The queue HTTP integration/browser workflows and actual PostgreSQL migration/backfill still require execution in an environment allowing those connections. No database migration or deployment was performed during this change.
