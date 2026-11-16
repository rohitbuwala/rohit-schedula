import { createHash } from 'node:crypto';
import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PgDialect } from 'drizzle-orm/pg-core';

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), select: vi.fn() }));
vi.mock('../db/database.js', () => ({ db: { transaction: mocks.transaction, select: mocks.select } }));
import { AppointmentsService } from './appointments.service.js';

const input = { doctorProfileId: '00000000-0000-4000-8000-000000000001', startsAt: new Date('2027-01-04T04:30:00Z'), endsAt: new Date('2027-01-04T05:00:00Z') };
const key = '00000000-0000-4000-8000-000000000002';
const hash = () => createHash('sha256').update(JSON.stringify([input.doctorProfileId, input.startsAt.toISOString(), input.endsAt.toISOString()])).digest('hex');
const hold = { id: '00000000-0000-4000-8000-000000000003', startsAt: input.startsAt, endsAt: input.endsAt, status: 'pending_payment' as const, holdExpiresAt: new Date('2027-01-01T00:10:00Z') };

function transaction(previous: unknown[]) {
  const values = vi.fn().mockResolvedValue(undefined);
  const limit = vi.fn().mockResolvedValue(previous);
  const where = vi.fn(() => ({ limit }));
  const innerJoin = vi.fn(() => ({ where }));
  const from = vi.fn(() => ({ innerJoin }));
  const tx = { execute: vi.fn().mockResolvedValue(undefined), select: vi.fn(() => ({ from })), insert: vi.fn(() => ({ values })) };
  mocks.transaction.mockImplementation(async (run) => run(tx));
  return { tx, values };
}

describe('appointment idempotency and hold recovery', () => {
  beforeEach(() => { vi.resetAllMocks(); });
  it('returns the committed result on a retry and rejects a changed payload', async () => {
    const { tx } = transaction([{ ...hold, payloadHash: hash() }]);
    const service = new AppointmentsService({} as never);
    const result = await service.createForPatient('patient-a', input, key);
    expect(result).toEqual(hold);
    expect(tx.execute).toHaveBeenCalledTimes(2);
    expect(tx.insert).not.toHaveBeenCalled();
    await expect(service.createForPatient('patient-a', { ...input, endsAt: new Date('2027-01-04T05:30:00Z') }, key)).rejects.toBeInstanceOf(ConflictException);
  });
  it('records a patient-bound payload hash in the same transaction as creation', async () => {
    const { tx, values } = transaction([]);
    const service = new AppointmentsService({} as never);
    const create = vi.spyOn(service as unknown as { createPatientHold: () => Promise<typeof hold> }, 'createPatientHold').mockResolvedValue(hold);
    await expect(service.createForPatient('patient-a', input, key)).resolves.toEqual(hold);
    expect(create).toHaveBeenCalledOnce();
    expect(values).toHaveBeenCalledWith({ patientId: 'patient-a', key, payloadHash: hash(), appointmentId: hold.id });
    expect(tx.execute).toHaveBeenCalledTimes(3);
  });
  it('serializes cross-patient concurrent requests for the same slot with doctor-slot advisory lock', async () => {
    const executedQueries: string[] = [];
    let activeSlotLock: string | null = null;
    let slotLockRelease!: () => void;
    const lockWait = new Promise<void>((resolve) => { slotLockRelease = resolve; });

    mocks.transaction.mockImplementation(async (run) => {
      const tx = {
        execute: vi.fn(async (query: { queryChunks?: unknown[] }) => {
          const sqlString = JSON.stringify(query);
          executedQueries.push(sqlString);
          if (sqlString.includes(input.doctorProfileId)) {
            if (activeSlotLock === input.doctorProfileId) {
              await lockWait;
            } else {
              activeSlotLock = input.doctorProfileId;
            }
          }
        }),
        select: vi.fn(() => ({
          from: () => ({
            innerJoin: () => ({
              where: () => ({ limit: async () => [] }),
            }),
          }),
        })),
        insert: vi.fn(() => ({
          values: vi.fn().mockResolvedValue(undefined),
        })),
      };
      try {
        return await run(tx);
      } finally {
        if (activeSlotLock === input.doctorProfileId) {
          activeSlotLock = null;
          slotLockRelease();
        }
      }
    });

    const service = new AppointmentsService({} as never);
    let holdCount = 0;
    vi.spyOn(service as unknown as { createPatientHold: () => Promise<typeof hold> }, 'createPatientHold')
      .mockImplementation(async () => {
        holdCount += 1;
        if (holdCount > 1) {
          throw new ConflictException('The selected doctor already has a scheduled appointment in that time slot.');
        }
        return hold;
      });

    const keyB = '00000000-0000-4000-8000-000000000004';
    const [resA, resB] = await Promise.allSettled([
      service.createForPatient('patient-a', input, key),
      service.createForPatient('patient-b', input, keyB),
    ]);

    expect(resA.status).toBe('fulfilled');
    expect(resB.status).toBe('rejected');
    if (resB.status === 'rejected') {
      expect(resB.reason).toBeInstanceOf(ConflictException);
    }
    // Verify both patient lock (seed 0) and doctor-slot lock (seed 1) were executed
    expect(executedQueries.some((q) => q.includes('patient-a') && q.includes(key))).toBe(true);
    expect(executedQueries.some((q) => q.includes('patient-b') && q.includes(keyB))).toBe(true);
    expect(executedQueries.filter((q) => q.includes(input.doctorProfileId) && q.includes(input.startsAt.toISOString()))).toHaveLength(2);
  });
  it('serializes concurrent duplicate requests and separates patients', async () => {
    const records = new Map<string, typeof hold & { payloadHash: string }>();
    let queue = Promise.resolve();
    mocks.transaction.mockImplementation(async (run) => {
      let release!: () => void;
      const previous = queue;
      queue = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      const where = (condition: Parameters<InstanceType<typeof PgDialect>['sqlToQuery']>[0]) => {
        const params = new PgDialect().sqlToQuery(condition).params;
        const record = records.get(`${params[0]}:${params[1]}`);
        return { limit: async () => record ? [record] : [] };
      };
      const tx = { execute: async () => {}, select: () => ({ from: () => ({ innerJoin: () => ({ where }) }) }),
        insert: () => ({ values: async (value: { patientId: string; key: string; payloadHash: string }) => {
          records.set(`${value.patientId}:${value.key}`, { ...hold, payloadHash: value.payloadHash });
        } }) };
      try { return await run(tx); } finally { release(); }
    });
    const service = new AppointmentsService({} as never);
    const create = vi.spyOn(service as unknown as { createPatientHold: () => Promise<typeof hold> }, 'createPatientHold').mockResolvedValue(hold);
    const results = await Promise.all([service.createForPatient('patient-a', input, key), service.createForPatient('patient-a', input, key)]);
    expect(results).toEqual([hold, hold]);
    expect(create).toHaveBeenCalledTimes(1);
    await service.createForPatient('patient-b', input, key);
    expect(create).toHaveBeenCalledTimes(2);
  });
  it('queries recovery by authenticated patient, pending state, and unexpired hold', async () => {
    let condition: Parameters<InstanceType<typeof PgDialect>['sqlToQuery']>[0] | undefined;
    const limit = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([hold]);
    const where = vi.fn((value) => { condition = value; return { limit }; });
    const innerJoin = vi.fn().mockReturnThis();
    const from = vi.fn(() => ({ innerJoin, where }));
    innerJoin.mockReturnValue({ innerJoin, where });
    mocks.select.mockReturnValue({ from });
    const service = new AppointmentsService({} as never);
    await expect(service.recoverPatientHold('patient-a', hold.id)).rejects.toBeInstanceOf(NotFoundException);
    const query = new PgDialect().sqlToQuery(condition!);
    expect(query.params).toContain('patient-a');
    expect(query.params).toContain('pending_payment');
    expect(query.params.some((value) => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value))).toBe(true);
    expect(query.sql).toContain('hold_expires_at');
    await expect(service.recoverPatientHold('patient-a', hold.id)).resolves.toEqual(hold);
  });
  it('maps PostgreSQL 55P03 lock timeout error to ServiceUnavailableException', async () => {
    const tx = {
      execute: vi.fn().mockImplementation(async (query: { queryChunks?: unknown[] }) => {
        const sqlString = JSON.stringify(query);
        if (sqlString.includes('pg_advisory_xact_lock')) {
          const timeoutErr = new Error('canceling statement due to lock timeout');
          (timeoutErr as { code?: string }).code = '55P03';
          throw timeoutErr;
        }
      }),
      select: vi.fn(),
      insert: vi.fn(),
    };
    mocks.transaction.mockImplementation(async (run) => run(tx));
    const service = new AppointmentsService({} as never);
    await expect(service.createForPatient('patient-a', input, key)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
