import { createAuthClient } from "better-auth/react";
import { backendUrl } from "@/lib/api";

export const authClient = createAuthClient({
  baseURL: backendUrl,
  fetchOptions: { credentials: "include" },
});
