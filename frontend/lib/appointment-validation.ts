import { z } from "zod";

export const appointmentFormSchema = z.object({
  doctorProfileId: z.uuid("Choose an approved doctor."),
  startsAt: z.string().min(1, "Choose a start date and time."),
  endsAt: z.string().min(1, "Choose an end date and time."),
}).superRefine(({ startsAt, endsAt }, context) => {
  const start = new Date(startsAt).getTime();
  const end = new Date(endsAt).getTime();
  if (!Number.isFinite(start) || start <= Date.now()) {
    context.addIssue({ code: "custom", path: ["startsAt"], message: "Choose a future start time." });
  }
  if (!Number.isFinite(end) || end <= start) {
    context.addIssue({ code: "custom", path: ["endsAt"], message: "End time must be after the start time." });
  }
});
