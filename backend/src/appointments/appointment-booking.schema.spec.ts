import { appointmentBookingSchema } from './appointment-booking.schema.js';
import { createZonedDate } from './appointment-availability.js';

describe('appointmentBookingSchema', () => {
  const doctorProfileId = '00000000-0000-4000-8000-000000000001';

  it('accepts future 30-minute booking in Asia/Kolkata (IST)', () => {
    // 2027-01-04 is a Monday, 10:00 IST = 04:30 UTC
    const startsAt = createZonedDate('2027-01-04', 10, 0, 'Asia/Kolkata').toISOString();
    const endsAt = createZonedDate('2027-01-04', 10, 30, 'Asia/Kolkata').toISOString();

    const result = appointmentBookingSchema.safeParse({
      doctorProfileId,
      startsAt,
      endsAt,
    });
    expect(result.success).toBe(true);
  });

  it('accepts future 15-minute booking in Asia/Kolkata (IST)', () => {
    // 2027-01-04 10:00 - 10:15 IST
    const startsAt = createZonedDate('2027-01-04', 10, 0, 'Asia/Kolkata').toISOString();
    const endsAt = createZonedDate('2027-01-04', 10, 15, 'Asia/Kolkata').toISOString();

    const result = appointmentBookingSchema.safeParse({
      doctorProfileId,
      startsAt,
      endsAt,
    });
    expect(result.success).toBe(true);
  });

  it('strictly rejects past appointment timestamps', () => {
    const pastStart = new Date(Date.now() - 3600_000).toISOString();
    const pastEnd = new Date(Date.now() - 1800_000).toISOString();

    const result = appointmentBookingSchema.safeParse({
      doctorProfileId,
      startsAt: pastStart,
      endsAt: pastEnd,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes('future'))).toBe(true);
    }
  });

  it('rejects appointments where endsAt is before startsAt', () => {
    const futureStart = createZonedDate('2027-01-04', 11, 0, 'Asia/Kolkata').toISOString();
    const futureEnd = createZonedDate('2027-01-04', 10, 30, 'Asia/Kolkata').toISOString();

    const result = appointmentBookingSchema.safeParse({
      doctorProfileId,
      startsAt: futureStart,
      endsAt: futureEnd,
    });
    expect(result.success).toBe(false);
  });

  it('rejects slots outside clinic operating hours', () => {
    // 20:00 IST is outside 09:00 - 17:00
    const outStart = createZonedDate('2027-01-04', 20, 0, 'Asia/Kolkata').toISOString();
    const outEnd = createZonedDate('2027-01-04', 20, 30, 'Asia/Kolkata').toISOString();

    const result = appointmentBookingSchema.safeParse({
      doctorProfileId,
      startsAt: outStart,
      endsAt: outEnd,
    });
    expect(result.success).toBe(false);
  });
});
