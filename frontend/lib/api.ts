const rawBackendUrl = process.env.NEXT_PUBLIC_AUTH_URL ?? "http://localhost:5000";
export const backendUrl =
  typeof window !== "undefined" ? "" : rawBackendUrl.replace(/\/+$/, "");
