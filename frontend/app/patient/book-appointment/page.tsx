import { redirect } from "next/navigation";
import { getVerifiedSession, dashboardPath } from "@/lib/auth-server";
import { PatientBooking } from "@/components/patient-booking";
import { AppShell } from "@/components/app-shell";
import { bookingSelectionSchema } from "@/lib/appointment-validation";

export const instant = false;

export default async function BookAppointmentPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getVerifiedSession();
  if (!session) redirect("/login");
  if (session.user.role !== "patient") redirect(dashboardPath(session.user.role));
  const params = await searchParams;
  const selection = bookingSelectionSchema.safeParse(params);
  const holdId = params.holdId === undefined ? undefined : typeof params.holdId === "string" ? params.holdId : "";

  return (
    <AppShell role="patient" userName={session.user.name}>
      <PatientBooking name={session.user.name} initialSelection={selection.data} initialHoldId={holdId} />
    </AppShell>
  );
}
