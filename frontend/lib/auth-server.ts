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

export async function getPostLoginRedirect(cookie?: string | null): Promise<string> {
  const session = await getVerifiedSession();
  if (!session) return "/login";
  if (session.user.role === "admin") return "/admin";
  if (session.user.role === "doctor") return "/doctor/dashboard";

  // For patient accounts, check if they have a doctor application pending review
  try {
    const rawCookie = cookie ?? (await headers()).get("cookie");
    if (rawCookie) {
      const res = await fetch(`${authUrl}/api/doctor-applications/me`, {
        headers: { cookie: rawCookie },
        cache: "no-store",
      });
      if (res.ok) {
        const text = await res.text();
        if (text && text.trim().length > 0) {
          const app = JSON.parse(text);
          if (app && (app.status === "pending" || app.status === "rejected")) {
            return "/doctor/dashboard";
          }
        }
      }
    }
  } catch {
    // fallback to patient dashboard
  }

  return "/patient/dashboard";
}
