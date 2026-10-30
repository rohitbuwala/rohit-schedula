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
