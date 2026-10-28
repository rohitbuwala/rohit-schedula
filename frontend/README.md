# Schedula frontend

## Local authentication

1. Copy `.env.example` to `.env.local`; `NEXT_PUBLIC_AUTH_URL` must use the same hostname as the backend URL (`localhost` for both), with the backend port (default `5000`).
2. Set backend `FRONTEND_URL=http://localhost:3000`, `BETTER_AUTH_URL=http://localhost:5000`, and the required database/auth secrets in `backend/.env`.
3. Start backend and frontend (`npm run start:dev` in `backend`, `npm run dev` here). Auth requests use credentialed cookies and the backend CORS allowlist.

Public signup creates patient accounts only. Doctor access requires a doctor role granted through a trusted administrative process; signup never submits a role. Dashboard routes verify the session with the backend on the server.
