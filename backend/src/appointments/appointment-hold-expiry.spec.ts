import { ConflictException } from '@nestjs/common';
import { AppointmentExpiryService } from './appointment-expiry.service.js';
import { AppointmentsService } from './appointments.service.js';
import { getAvailableSlots } from './appointment-availability.js';
import { db } from '../db/database.js';
import { appointment, payment } from '../db/schema.js';

vi.mock('../db/database.js', () => ({
  db: {
    select: vi.fn(),
    transaction: vi.fn(),
    delete: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
  },
}));

describe('Appointment Hold & Expiry Logic (Phase 4)', () => {
  let expiryService: AppointmentExpiryService;
  let appointmentsService: AppointmentsService;
  let mockDoctors: any;

  beforeEach(() => {
    vi.clearAllMocks();
    expiryService = new AppointmentExpiryService();
    mockDoctors = {
      isApproved: vi.fn().mockResolvedValue(true),
    };
    appointmentsService = new AppointmentsService(mockDoctors);
  });

  describe('Slot Availability with Pending Holds', () => {
    const now = new Date('2027-01-04T08:00:00Z');

    it('blocks slots with active pending_payment hold', () => {
      const activeHoldExpiresAt = new Date('2027-01-04T08:10:00Z'); // 10 mins in future
      const slots = getAvailableSlots(
        '2027-01-04',
        [
          {
            startsAt: new Date('2027-01-04T09:00:00Z'),
            endsAt: new Date('2027-01-04T09:30:00Z'),
            status: 'pending_payment',
            holdExpiresAt: activeHoldExpiresAt,
          },
        ],
        now,
      );

      // The 09:00-09:30 slot must be removed because hold is active
      expect(slots.some((s) => s.startsAt.toISOString() === '2027-01-04T09:00:00.000Z')).toBe(false);
    });

    it('frees slots whose pending_payment hold has expired', () => {
      const expiredHold = new Date('2027-01-04T07:55:00Z'); // 5 mins in past
      const slots = getAvailableSlots(
        '2027-01-04',
        [
          {
            startsAt: new Date('2027-01-04T09:00:00Z'),
            endsAt: new Date('2027-01-04T09:30:00Z'),
            status: 'pending_payment',
            holdExpiresAt: expiredHold,
          },
        ],
        now,
      );

      // The 09:00-09:30 slot should be bookable because hold has expired
      expect(slots.some((s) => s.startsAt.toISOString() === '2027-01-04T09:00:00.000Z')).toBe(true);
    });
  });

  describe('Atomic 10-Minute Hold Creation', () => {
    const patientId = 'patient-1';
    const doctorProfileId = '00000000-0000-4000-8000-000000000001';
    // Monday 2027-01-04 at 10:00 IST (04:30 UTC)
    const startsAt = new Date('2027-01-04T04:30:00.000Z');
    const endsAt = new Date('2027-01-04T05:00:00.000Z');

    const setupDoctorMock = () => {
      (db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnValueOnce({
          innerJoin: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              limit: vi.fn().mockResolvedValueOnce([{ userId: 'doctor-user-1' }]),
            }),
          }),
        }),
      });
    };

    const setupCapacityTransaction = (occupiedRows: unknown[] = [], insertResult?: unknown[], insertError?: Error, capacity = 1) => {
      const queuedResults = [[{}], [{ capacity }], [], occupiedRows]; // doctor lock, weekly config, date override, active occupancy
      const tx: any = {
        select: vi.fn(() => {
          const result = queuedResults.shift() ?? [];
          const builder: any = {
            from: vi.fn(() => builder),
            where: vi.fn(() => builder),
            for: vi.fn(() => builder),
            limit: vi.fn(() => builder),
            then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
          };
          return builder;
        }),
        update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })) })),
        insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: insertError
          ? vi.fn().mockRejectedValue(insertError)
          : vi.fn().mockResolvedValue(insertResult ?? []),
        })) })),
      };
      (db.transaction as any).mockImplementationOnce((callback: (transaction: unknown) => unknown) => callback(tx));
      return tx;
    };

    it('creates appointment with status pending_payment and 10-minute hold', async () => {
      // 1. Doctor query (findApprovedDoctor)
      setupDoctorMock();

      // 4. DB Insert appointment
      const mockCreated = {
        id: 'appt-new-1',
        startsAt,
        endsAt,
        status: 'pending_payment',
        holdExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
      };
      const tx = setupCapacityTransaction([], [mockCreated]);

      const res = await appointmentsService.createForPatient(patientId, {
        doctorProfileId,
        startsAt,
        endsAt,
      });

      expect(res.status).toBe('pending_payment');
      expect(res.holdExpiresAt).toBeDefined();
      expect(res.holdExpiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(tx.insert).toHaveBeenCalled();
    });

    it('rejects booking when slot has an active pending hold', async () => {
      // 1. Doctor query
      setupDoctorMock();

      const tx = setupCapacityTransaction([{ id: 'existing-hold-1' }]);

      await expect(
        appointmentsService.createForPatient(patientId, {
          doctorProfileId,
          startsAt,
          endsAt,
        }),
      ).rejects.toThrow(ConflictException);

      expect(tx.insert).not.toHaveBeenCalled();
    });

    it('allows another hold while a configured wave still has capacity', async () => {
      setupDoctorMock();
      const created = {
        id: 'appt-wave-2', startsAt, endsAt, status: 'pending_payment',
        holdExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
      };
      const tx = setupCapacityTransaction([{ id: 'existing-pending-hold' }], [created], undefined, 2);

      const result = await appointmentsService.createForPatient(patientId, { doctorProfileId, startsAt, endsAt });
      expect(result.id).toBe('appt-wave-2');
      expect(tx.insert).toHaveBeenCalled();
    });

    it('converts Postgres exclusion error 23P01 into ConflictException', async () => {
      // 1. Doctor query
      setupDoctorMock();

      // 4. DB Insert throws exclusion violation 23P01 from PostgreSQL
      const postgresExclusionError = new Error('exclusion violation');
      (postgresExclusionError as any).code = '23P01';
      setupCapacityTransaction([], undefined, postgresExclusionError);

      await expect(
        appointmentsService.createForPatient(patientId, {
          doctorProfileId,
          startsAt,
          endsAt,
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('AppointmentExpiryService Background Cleanup', () => {
    it('returns 0 when no expired holds exist', async () => {
      const mockTx = {
        select: vi.fn().mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockResolvedValueOnce([]), // 0 expired holds
          }),
        }),
      };
      (db.transaction as any).mockImplementationOnce(async (cb: any) => cb(mockTx));

      const count = await expiryService.cleanupExpiredHolds();
      expect(count).toBe(0);
    });

    it('cancels expired unpaid appointment and marks created payment as failed', async () => {
      const expiredApptId = 'appt-expired-1';
      const mockTx = {
        select: vi
          .fn()
          // 1. Select expired appointments
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockResolvedValueOnce([
                  {
                    id: expiredApptId,
                    patientId: 'pat-1',
                    doctorId: 'doc-1',
                  },
                ]),
            }),
          })
          // 2. Select payment record for appt
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                for: vi.fn().mockReturnValueOnce({
                  limit: vi.fn().mockResolvedValueOnce([
                    {
                      id: 'pay-1',
                      status: 'created',
                    },
                  ]),
                }),
              }),
            }),
          })
          // 3. Lock/recheck the expired appointment after locking its payment
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                for: vi.fn().mockReturnValueOnce({
                  limit: vi.fn().mockResolvedValueOnce([{
                    id: expiredApptId,
                    patientId: 'pat-1',
                    doctorId: 'doc-1',
                    startsAt: new Date('2027-01-02T12:00:00Z'),
                    reminderGeneration: 0,
                  }]),
                }),
              }),
            }),
          }),
        update: vi
          .fn()
          // 1. update payment to failed
          .mockReturnValueOnce({
            set: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockResolvedValueOnce([]),
            }),
          })
          // 2. update appointment to cancelled
          .mockReturnValueOnce({
            set: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockResolvedValueOnce([]),
            }),
          }),
      };
      (db.transaction as any).mockImplementationOnce(async (cb: any) => cb(mockTx));

      const count = await expiryService.cleanupExpiredHolds();
      expect(count).toBe(1);
      expect(mockTx.update).toHaveBeenCalledTimes(2); // payment failed + appt cancelled
    });

    it('resolves payment success vs expiry race condition without cancelling appointment', async () => {
      // Race condition scenario: Payment was captured right as cleanup was running
      const raceApptId = 'appt-race-1';
      const mockTx = {
        select: vi
          .fn()
          // 1. Found in expired list
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockResolvedValueOnce([
                  {
                    id: raceApptId,
                    patientId: 'pat-1',
                    doctorId: 'doc-1',
                  },
                ]),
            }),
          })
          // 2. Payment check reveals it was captured!
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                for: vi.fn().mockReturnValueOnce({
                  limit: vi.fn().mockResolvedValueOnce([
                    {
                      id: 'pay-1',
                      status: 'captured',
                    },
                  ]),
                }),
              }),
            }),
          })
          // 3. Lock/recheck the appointment after the payment lock
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                for: vi.fn().mockReturnValueOnce({
                  limit: vi.fn().mockResolvedValueOnce([{
                    id: raceApptId,
                    patientId: 'pat-1',
                    doctorId: 'doc-1',
                    startsAt: new Date('2027-01-02T12:00:00Z'),
                    reminderGeneration: 0,
                  }]),
                }),
              }),
            }),
          }),
        update: vi
          .fn()
          // Updates appointment to scheduled, does NOT cancel
          .mockReturnValueOnce({
            set: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockResolvedValueOnce([]),
            }),
          }),
      };
      (db.transaction as any).mockImplementationOnce(async (cb: any) => cb(mockTx));

      const count = await expiryService.cleanupExpiredHolds();
      // 0 appointments cancelled
      expect(count).toBe(0);
      expect(mockTx.update).toHaveBeenCalled();
      expect(mockTx.select.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ id: payment.id }));
      expect(mockTx.select.mock.calls[2]?.[0]).toEqual(expect.objectContaining({ id: appointment.id }));
    });

    it('is idempotent across duplicate cleanup runs and server restarts', async () => {
      const mockTx = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        }),
      };
      (db.transaction as any).mockImplementation(async (cb: any) => cb(mockTx));

      // Multiple sweeps simulate server restart and recurring cron
      await expiryService.onModuleInit();
      const count1 = await expiryService.cleanupExpiredHolds();
      const count2 = await expiryService.cleanupExpiredHolds();

      expect(count1).toBe(0);
      expect(count2).toBe(0);
    });
  });
});
