import { headers } from "next/headers";
import { z } from "zod";

const sessionSchema = z.object({
  user: z.object({ id: z.string(), name: z.string(), email: z.email(), role: z.enum(["patient", "doctor", "admin"]).optional() }),
  session: z.object({ id: z.string() }),
}).passthrough();

const authUrl = (process.env.NEXT_PUBLIC_AUTH_URL ?? "http://localhost:5000").replace(/\/+$/, "");

export async function getVerifiedSession() {
  try {
    const cookie = (await headers()).get("cookie");
    if (!cookie) return null;
    const response = await fetch(`${authUrl}/api/auth/get-session`, {
      headers: { cookie }, cache: "no-store",
    });
    if (!response.ok) return null;
    const result = sessionSchema.safeParse(await response.json());
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function dashboardPath(role?: string) {
  if (role === "admin") return "/admin";
  return role === "doctor" ? "/doctor/dashboard" : "/patient/dashboard";
}
