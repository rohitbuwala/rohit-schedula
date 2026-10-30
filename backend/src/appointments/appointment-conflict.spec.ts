import { appointmentWriteError, createWithConflictHandling, overlaps } from './appointment-conflict.js';

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
});
