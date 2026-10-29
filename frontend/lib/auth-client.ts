import { createAuthClient } from "better-auth/react";
import { backendUrl } from "@/lib/api";

// Keep browser auth on the frontend origin so the Next.js rewrite can proxy
// requests and the browser stores the session cookie for the preview domain.
const authBaseURL =
  typeof window !== "undefined" ? window.location.origin : backendUrl;

export const authClient = createAuthClient({
  baseURL: authBaseURL,
  fetchOptions: { credentials: "include" },
});
