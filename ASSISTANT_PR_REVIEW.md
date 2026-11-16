# Assistant review and PR order

This work is split into dependent branches. Open each PR against the base below,
not against `main`. This keeps every PR at 17 changed files or fewer. Merge in
order and retarget the next PR only after its base has merged.

| Order | Branch | PR base | Files | Scope |
| --- | --- | --- | ---: | --- |
| 1 | `codex/01-runtime-hardening` | `main` | 14 | Authentication, request boundaries and database diagnostics |
| 2 | `codex/02-booking-read-and-recovery` | `codex/01-runtime-hardening` | 17 | Read models, keyed booking recovery and migrations |
| 3 | `codex/03-payment-and-expiry-reliability` | `codex/02-booking-read-and-recovery` | 11 | Payment verification, reconciliation and hold expiry |
| 4 | `codex/04-assistant-chat-backend` | `codex/03-payment-and-expiry-reliability` | 11 | Role-aware chat, tools and booking intent |
| 5 | `codex/05-assistant-voice-backend` | `codex/04-assistant-chat-backend` | 8 | Authenticated transcription, synthesis and module wiring |
| 6 | `codex/06-chat-state-and-validation` | `codex/05-assistant-voice-backend` | 16 | Validated responses, booking/payment helpers and seven-day history |
| 7 | `codex/07-browser-voice-runtime` | `codex/06-chat-state-and-validation` | 10 | Recorder, silence detection, playback and window controls |
| 8 | `codex/08-assistant-ui-and-checkout` | `codex/07-browser-voice-runtime` | 16 | Dashboard UI, voice controls, checkout and Webpack/CSS setup |
| 9 | `codex/09-integration-and-review` | `codex/08-assistant-ui-and-checkout` | 15 | Integration fixtures, diagnostics and these review notes |

## File review

- Keep source modules, their regression tests, SQL migrations, generated Drizzle
  snapshots, the journal, dependency lockfile and integration-test safeguards.
  These are required dependencies or verification, not disposable file-count overhead.
- Removed the unused browser speech-recognition and speech-synthesis engines.
  The active voice flow uses the WAV recorder, server transcription and server
  synthesis. Shared transcript/error helpers remain.
- Removed the unused `@tailwindcss/turbopack` dependency after switching to Webpack
  and the Tailwind PostCSS plugin.
- Kept the existing scheduling/date-override/capacity features from current `main`.
  The assistant migrations follow them as `0016` and `0017` rather than reusing
  the scheduling migrations' numbers.
- Environment secrets, dependencies, generated Next.js output and local caches
  are ignored and must not be added to a PR.
- A local safety branch preserves the original unsplit work. It is not a PR base
  and is not part of the branches to push.

## Verification

- Backend: 516 unit/controller tests pass; production build passes; lint has no errors.
- Frontend: all 164 unit tests pass; production build passes; lint has no errors.
- Database-target safeguards: four tests pass. The app database has the expected
  scheduling, capacity and reminder schema.
- The isolated database integration check is blocked by rejected test-database
  credentials (`28P01`). Do not substitute the application's database for it.
- Browser fixtures use a separate `.next-e2e` directory and fake microphone,
  payment and backend responses. The full browser regression passes, including
  dictation, live voice cycling, panel controls, booking retries after reload,
  and checkout recovery. It does not charge a card or send email.
- Automated audio fixtures do not establish real microphone quality, speech API
  availability, or real Razorpay completion. Those still require a manual check
  with valid provider/test credentials.

## Reviewer checks

1. Follow the PR order above. Build each branch with its preceding branches present.
2. Review migrations before applying them. Existing development databases that
   previously applied the old assistant-numbered migrations need their migration
   ledger checked before reapplying the renumbered SQL; do not delete data or run
   migrations blindly when the tables already exist.
3. Run backend `npm test` and `npm run build`.
4. Run frontend `node --experimental-strip-types --test tests/*.test.mjs`,
   `npm run lint`, and `npm run build`.
5. Run `npm run test:assistant:e2e` in the frontend for the isolated browser fixture.
6. Configure the isolated database variables from `backend/.env.example` before
   running the database-backed HTTP integration commands. Keep credentials local.
7. Manually check typed chat after booking, seven-day history, voice start/stop,
   speech-end detection, spoken replies, payment dismissal and payment verification.
