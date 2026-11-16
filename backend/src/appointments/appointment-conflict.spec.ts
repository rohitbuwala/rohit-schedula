import { appointmentWriteError, createWithConflictHandling, isLockTimeoutViolation, overlaps, reserveWithinCapacity } from './appointment-conflict.js';

describe('scheduled appointment overlap semantics', () => {
  const base = new Date('2027-01-01T10:00:00Z');
  const hour = 60 * 60 * 1000;

  it('detects overlapping intervals', () => {
    expect(overlaps(base, new Date(+base + hour), new Date(+base + 30 * 60_000), new Date(+base + 2 * hour))).toBe(true);
  });

  it('allows back-to-back half-open intervals', () => {
    expect(overlaps(base, new Date(+base + hour), new Date(+base + hour), new Date(+base + 2 * hour))).toBe(false);
  });

  it('maps PostgreSQL exclusion violations, including wrapped causes, to conflict', () => {
    expect(appointmentWriteError({ code: '23P01' })?.getStatus()).toBe(409);
    expect(appointmentWriteError({ cause: { code: '23P01' } })?.getStatus()).toBe(409);
    expect(appointmentWriteError({ code: '23505' })).toBeNull();
  });

  it('detects PostgreSQL 55P03 lock timeout errors directly and in wrapped causes', () => {
    expect(isLockTimeoutViolation({ code: '55P03' })).toBe(true);
    expect(isLockTimeoutViolation({ cause: { code: '55P03' } })).toBe(true);
    expect(isLockTimeoutViolation({ cause: { cause: { code: '55P03' } } })).toBe(true);
    expect(isLockTimeoutViolation({ code: '23P01' })).toBe(false);
    expect(isLockTimeoutViolation(null)).toBe(false);
  });

  it('returns one success and one 409 for simultaneous conflicting inserts', async () => {
    let arrivals = 0;
    let release!: () => void;
    const bothArrived = new Promise<void>((resolve) => { release = resolve; });
    let occupied = false;
    const simulatedInsert = async () => {
      arrivals += 1;
      if (arrivals === 2) release();
      await bothArrived;
      if (occupied) throw { code: '23P01' };
      occupied = true;
      return 'created';
    };

    const results = await Promise.allSettled([
      createWithConflictHandling(simulatedInsert),
      createWithConflictHandling(simulatedInsert),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason.getStatus()).toBe(409);
  });

  it('serializes simultaneous reservations and never exceeds configured capacity', async () => {
    let activeHolds = 0;
    let tail = Promise.resolve();
    const reserve = () => {
      let release!: () => void;
      const prior = tail;
      tail = new Promise<void>((resolve) => { release = resolve; });
      return prior.then(async () => {
        try {
          return await reserveWithinCapacity(
            async () => {}, // The enclosing transaction already owns the database row lock.
            async () => 2,
            async () => activeHolds, // Pending-payment holds count toward capacity.
            async () => { activeHolds++; return 'hold-created'; },
          );
        } finally {
          release();
        }
      });
    };

    const results = await Promise.allSettled([reserve(), reserve(), reserve()]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(activeHolds).toBe(2);
  });

  it('serializes late payment recovery against a new booking at capacity one', async () => {
    let occupied = 0;
    let tail = Promise.resolve();
    const acquireDoctorRowLock = async () => {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      return release;
    };
    const reserve = async (kind: 'booking' | 'late payment') => {
      let release: (() => void) | undefined;
      try {
        await reserveWithinCapacity(
          async () => { release = await acquireDoctorRowLock(); },
          async () => 1,
          async () => occupied,
          async () => { occupied += 1; return kind; },
        );
        return kind;
      } finally {
        release?.();
      }
    };

    const results = await Promise.allSettled([reserve('booking'), reserve('late payment')]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(occupied).toBe(1);
  });
});
