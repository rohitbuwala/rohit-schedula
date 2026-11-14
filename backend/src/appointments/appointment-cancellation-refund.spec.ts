import { ConflictException, NotFoundException } from '@nestjs/common';
import { AppointmentsService, resolvePaymentStatusDisplay } from './appointments.service.js';
import { AppointmentExpiryService } from './appointment-expiry.service.js';
import { PaymentReconciliationService } from '../payments/payment-reconciliation.service.js';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { db } from '../db/database.js';
import { appointment, payment } from '../db/schema.js';

vi.mock('../db/database.js', () => ({
  db: {
    transaction: vi.fn(),
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

describe('Appointment Cancellation & Immediate Refund Integration', () => {
  const appointmentId = '00000000-0000-4000-8000-000000000001';
  const paymentId = 'pay-uuid-1';
  const patientId = 'patient-123';
  const doctorId = 'doctor-456';

  const patientActor: AuthenticatedUser = {
    id: patientId,
    role: 'patient',
    email: 'patient@example.com',
    name: 'Patient User',
  };

  const doctorActor: AuthenticatedUser = {
    id: doctorId,
    role: 'doctor',
    email: 'doctor@example.com',
    name: 'Doctor User',
  };

  let mockDoctors: any;
  let mockNotifications: any;
  let mockPayments: any;
  let appointmentsService: AppointmentsService;

  beforeEach(() => {
    vi.clearAllMocks();

    mockDoctors = {
      isApproved: vi.fn().mockResolvedValue(true),
    };

    mockNotifications = {
      createNotification: vi.fn().mockResolvedValue({ id: 'notif-1' }),
    };

    mockPayments = {
      refundPayment: vi.fn().mockResolvedValue({
        id: 'rfnd-123',
        status: 'processed',
        amountPaise: 50000,
        arn: 'ARN_TEST_123',
      }),
    };

    appointmentsService = new AppointmentsService(
      mockDoctors as never,
      undefined,
      mockNotifications,
      mockPayments as never,
    );
  });

  describe('Immediate Refund Triggering', () => {
    it('does not cancel or refund an appointment owned by another patient', async () => {
      const select = vi.fn().mockReturnThis();
      const update = vi.fn();
      const tx = {
        select, update,
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        for: vi.fn().mockReturnThis(),
        limit: vi.fn()
          .mockResolvedValueOnce([{ id: paymentId, status: 'captured', amountPaise: 50000 }])
          .mockResolvedValueOnce([{ id: appointmentId, patientId: 'another-patient', doctorId, status: 'scheduled' }]),
      };
      vi.mocked(db.transaction).mockImplementationOnce(async (callback) => callback(tx as never));
      await expect(appointmentsService.cancel(appointmentId, patientActor, 'Appointment cancelled by patient: Other'))
        .rejects.toBeInstanceOf(NotFoundException);
      expect(update).not.toHaveBeenCalled();
      expect(mockPayments.refundPayment).not.toHaveBeenCalled();
    });

    it('1. triggers an immediate full refund when a paid scheduled appointment is cancelled by patient', async () => {
      const mockApptRecord = {
        id: appointmentId,
        patientId,
        doctorId,
        status: 'scheduled',
        startsAt: new Date('2026-12-01T10:00:00.000Z'),
      };

      const mockPayRecord = {
        id: paymentId,
        status: 'captured',
        amountPaise: 50000,
        refundedAmountPaise: 0,
      };
      const mockEmailOutbox = { enqueue: vi.fn().mockResolvedValue(undefined) };
      appointmentsService = new AppointmentsService(
        mockDoctors as never,
        undefined,
        mockNotifications,
        mockPayments as never,
        undefined,
        mockEmailOutbox as never,
      );

      const mockTx = {
        select: vi
          .fn()
          // 1. Payment lookup (Lock order: payment -> appointment)
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                for: vi.fn().mockReturnValueOnce({
                  limit: vi.fn().mockResolvedValueOnce([mockPayRecord]),
                }),
              }),
            }),
          })
          // 2. Appointment lookup
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                for: vi.fn().mockReturnValueOnce({
                  limit: vi.fn().mockResolvedValueOnce([mockApptRecord]),
                }),
              }),
            }),
          })
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockResolvedValueOnce([
                { id: patientId, name: 'Test Patient', email: 'patient@example.invalid' },
                { id: doctorId, name: 'Test Doctor', email: 'doctor@example.invalid' },
              ]),
            }),
          }),
        update: vi.fn().mockReturnValueOnce({
          set: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              returning: vi.fn().mockResolvedValueOnce([
                { id: appointmentId, status: 'cancelled', updatedAt: new Date() },
              ]),
            }),
          }),
        }),
      };

      (db.transaction as any).mockImplementationOnce(async (cb: any) => cb(mockTx));

      const result = await appointmentsService.cancel(appointmentId, patientActor, 'Appointment cancelled by patient: Schedule conflict');

      expect(result.status).toBe('cancelled');
      expect(result.refund).toBeDefined();
      expect(result.refund!.status).toBe('processed');
      expect(mockPayments.refundPayment).toHaveBeenCalledWith(
        patientId,
        'system',
        paymentId,
        expect.objectContaining({
          reason: 'Appointment cancelled by patient: Schedule conflict',
          amountPaise: 50000,
        }),
      );
      expect(mockNotifications.createNotification).toHaveBeenCalled();
      expect(mockEmailOutbox.enqueue).toHaveBeenCalledTimes(2);
      expect(mockEmailOutbox.enqueue).toHaveBeenCalledWith(
        mockTx,
        expect.objectContaining({ eventType: 'appointment_cancelled', appointmentId }),
      );
    });

    it('2. triggers an immediate full refund when a paid scheduled appointment is cancelled by doctor', async () => {
      const mockApptRecord = {
        id: appointmentId,
        patientId,
        doctorId,
        status: 'scheduled',
      };

      const mockPayRecord = {
        id: paymentId,
        status: 'captured',
        amountPaise: 50000,
        refundedAmountPaise: 0,
      };

      const mockTx = {
        select: vi
          .fn()
          // 1. Payment lookup (Lock order: payment -> appointment)
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                for: vi.fn().mockReturnValueOnce({
                  limit: vi.fn().mockResolvedValueOnce([mockPayRecord]),
                }),
              }),
            }),
          })
          // 2. Appointment lookup
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                for: vi.fn().mockReturnValueOnce({
                  limit: vi.fn().mockResolvedValueOnce([mockApptRecord]),
                }),
              }),
            }),
          }),
        update: vi.fn().mockReturnValueOnce({
          set: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              returning: vi.fn().mockResolvedValueOnce([
                { id: appointmentId, status: 'cancelled', updatedAt: new Date() },
              ]),
            }),
          }),
        }),
      };

      (db.transaction as any).mockImplementationOnce(async (cb: any) => cb(mockTx));

      const result = await appointmentsService.cancel(appointmentId, doctorActor);

      expect(result.status).toBe('cancelled');
      expect(mockPayments.refundPayment).toHaveBeenCalledWith(
        doctorId,
        'system',
        paymentId,
        expect.objectContaining({
          reason: 'Appointment cancelled by doctor',
          amountPaise: 50000,
        }),
      );
    });

    it('3. does NOT trigger a refund when an unpaid pending_payment hold is cancelled', async () => {
      const mockApptRecord = {
        id: appointmentId,
        patientId,
        doctorId,
        status: 'pending_payment',
      };

      const mockPayRecord = {
        id: paymentId,
        status: 'created',
        amountPaise: 50000,
        refundedAmountPaise: 0,
      };

      const mockTx = {
        select: vi
          .fn()
          // 1. Payment lookup (Lock order: payment -> appointment)
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                for: vi.fn().mockReturnValueOnce({
                  limit: vi.fn().mockResolvedValueOnce([mockPayRecord]),
                }),
              }),
            }),
          })
          // 2. Appointment lookup
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                for: vi.fn().mockReturnValueOnce({
                  limit: vi.fn().mockResolvedValueOnce([mockApptRecord]),
                }),
              }),
            }),
          }),
        update: vi
          .fn()
          // Update appointment to cancelled
          .mockReturnValueOnce({
            set: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                returning: vi.fn().mockResolvedValueOnce([
                  { id: appointmentId, status: 'cancelled', updatedAt: new Date() },
                ]),
              }),
            }),
          })
          // Update unpaid payment to failed
          .mockReturnValueOnce({
            set: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockResolvedValueOnce([]),
            }),
          }),
      };

      (db.transaction as any).mockImplementationOnce(async (cb: any) => cb(mockTx));

      const result = await appointmentsService.cancel(appointmentId, patientActor);

      expect(result.status).toBe('cancelled');
      expect(result.refund).toBeNull();
      expect(mockPayments.refundPayment).not.toHaveBeenCalled();
      // Verifies created payment was marked as failed
      expect(mockTx.update).toHaveBeenCalledTimes(2);
    });

    it('4. prevents duplicate refunds and throws ConflictException on already cancelled appointment', async () => {
      const mockApptRecord = {
        id: appointmentId,
        patientId,
        doctorId,
        status: 'cancelled',
      };

      const mockTx = {
        select: vi
          .fn()
          // 1. Payment lookup (Lock order: payment -> appointment)
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                for: vi.fn().mockReturnValueOnce({
                  limit: vi.fn().mockResolvedValueOnce([]),
                }),
              }),
            }),
          })
          // 2. Appointment lookup
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                for: vi.fn().mockReturnValueOnce({
                  limit: vi.fn().mockResolvedValueOnce([mockApptRecord]),
                }),
              }),
            }),
          }),
      };

      (db.transaction as any).mockImplementationOnce(async (cb: any) => cb(mockTx));

      await expect(appointmentsService.cancel(appointmentId, patientActor)).rejects.toThrow(
        ConflictException,
      );
      expect(mockPayments.refundPayment).not.toHaveBeenCalled();
    });

    it('5. refunds only the remaining balance on an already partially refunded appointment', async () => {
      const mockApptRecord = {
        id: appointmentId,
        patientId,
        doctorId,
        status: 'scheduled',
      };

      const mockPayRecord = {
        id: paymentId,
        status: 'captured',
        amountPaise: 50000,
        refundedAmountPaise: 20000, // Remaining balance: 30000
      };

      const mockTx = {
        select: vi
          .fn()
          // 1. Payment lookup (Lock order: payment -> appointment)
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                for: vi.fn().mockReturnValueOnce({
                  limit: vi.fn().mockResolvedValueOnce([mockPayRecord]),
                }),
              }),
            }),
          })
          // 2. Appointment lookup
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                for: vi.fn().mockReturnValueOnce({
                  limit: vi.fn().mockResolvedValueOnce([mockApptRecord]),
                }),
              }),
            }),
          }),
        update: vi.fn().mockReturnValueOnce({
          set: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              returning: vi.fn().mockResolvedValueOnce([
                { id: appointmentId, status: 'cancelled', updatedAt: new Date() },
              ]),
            }),
          }),
        }),
      };

      (db.transaction as any).mockImplementationOnce(async (cb: any) => cb(mockTx));

      const result = await appointmentsService.cancel(appointmentId, patientActor);

      expect(result.status).toBe('cancelled');
      expect(mockPayments.refundPayment).toHaveBeenCalledWith(
        patientId,
        'system',
        paymentId,
        expect.objectContaining({
          amountPaise: 30000,
        }),
      );
    });

    it('6. does NOT trigger a refund if payment is already fully refunded', async () => {
      const mockApptRecord = {
        id: appointmentId,
        patientId,
        doctorId,
        status: 'scheduled',
      };

      const mockPayRecord = {
        id: paymentId,
        status: 'refunded',
        amountPaise: 50000,
        refundedAmountPaise: 50000, // 0 remaining
      };

      const mockTx = {
        select: vi
          .fn()
          // 1. Payment lookup (Lock order: payment -> appointment)
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                for: vi.fn().mockReturnValueOnce({
                  limit: vi.fn().mockResolvedValueOnce([mockPayRecord]),
                }),
              }),
            }),
          })
          // 2. Appointment lookup
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                for: vi.fn().mockReturnValueOnce({
                  limit: vi.fn().mockResolvedValueOnce([mockApptRecord]),
                }),
              }),
            }),
          }),
        update: vi.fn().mockReturnValueOnce({
          set: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              returning: vi.fn().mockResolvedValueOnce([
                { id: appointmentId, status: 'cancelled', updatedAt: new Date() },
              ]),
            }),
          }),
        }),
      };

      (db.transaction as any).mockImplementationOnce(async (cb: any) => cb(mockTx));

      const result = await appointmentsService.cancel(appointmentId, patientActor);

      expect(result.status).toBe('cancelled');
      expect(result.refund).toBeNull();
      expect(mockPayments.refundPayment).not.toHaveBeenCalled();
    });

    it('7. safely handles Razorpay refund API failure: appointment cancels, error is logged, does not crash', async () => {
      const mockApptRecord = {
        id: appointmentId,
        patientId,
        doctorId,
        status: 'scheduled',
      };

      const mockPayRecord = {
        id: paymentId,
        status: 'captured',
        amountPaise: 50000,
        refundedAmountPaise: 0,
      };

      const mockTx = {
        select: vi
          .fn()
          // 1. Payment lookup (Lock order: payment -> appointment)
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                for: vi.fn().mockReturnValueOnce({
                  limit: vi.fn().mockResolvedValueOnce([mockPayRecord]),
                }),
              }),
            }),
          })
          // 2. Appointment lookup
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                for: vi.fn().mockReturnValueOnce({
                  limit: vi.fn().mockResolvedValueOnce([mockApptRecord]),
                }),
              }),
            }),
          }),
        update: vi.fn().mockReturnValueOnce({
          set: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              returning: vi.fn().mockResolvedValueOnce([
                { id: appointmentId, status: 'cancelled', updatedAt: new Date() },
              ]),
            }),
          }),
        }),
      };

      (db.transaction as any).mockImplementationOnce(async (cb: any) => cb(mockTx));
      mockPayments.refundPayment.mockRejectedValueOnce(new Error('Razorpay Gateway Timeout'));

      // The cancellation itself must NOT throw an unhandled error
      const result = await appointmentsService.cancel(appointmentId, patientActor);

      expect(result.status).toBe('cancelled');
      expect(result.refund).toBeNull();
      expect(mockPayments.refundPayment).toHaveBeenCalled();
    });

    it('8. reconciliation fallback sweeps cancelled appointments with unrefunded payments', async () => {
      const mockRazorpay = {
        refunds: {
          fetch: vi.fn(),
        },
      };

      const reconciliationService = new PaymentReconciliationService(
        mockPayments as never,
        mockRazorpay as never,
      );

      // Mock DB: 1 captured payment on a cancelled appointment
      (db.select as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            innerJoin: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                limit: vi.fn().mockResolvedValueOnce([
                  {
                    paymentId: 'pay-unrec-1',
                    amountPaise: 50000,
                    refundedAmountPaise: 0,
                    appointmentId: 'appt-cancelled-1',
                  },
                ]),
              }),
            }),
          }),
        })
        // Mock pending refund check (none)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              limit: vi.fn().mockResolvedValueOnce([]),
            }),
          }),
        })
        // Mock stale refunds query (none)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              limit: vi.fn().mockResolvedValueOnce([]),
            }),
          }),
        });

      const count = await reconciliationService.reconcileInconsistentPayments();

      expect(count).toBe(1);
      expect(mockPayments.refundPayment).toHaveBeenCalledWith(
        'SYSTEM_RECONCILIATION',
        'system',
        'pay-unrec-1',
        expect.objectContaining({
          reason: expect.stringContaining('Automated reconciliation'),
        }),
      );
    });

    it('9. throws an explicit Error and prevents silent skip if PaymentsService is missing when cancelling a paid appointment', async () => {
      const mockApptRecord = {
        id: appointmentId,
        patientId,
        doctorId,
        status: 'scheduled',
      };

      const mockPayRecord = {
        id: paymentId,
        status: 'captured',
        amountPaise: 50000,
        refundedAmountPaise: 0,
      };

      const mockTx = {
        select: vi
          .fn()
          // 1. Payment lookup (Lock order: payment -> appointment)
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                for: vi.fn().mockReturnValueOnce({
                  limit: vi.fn().mockResolvedValueOnce([mockPayRecord]),
                }),
              }),
            }),
          })
          // 2. Appointment lookup
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                for: vi.fn().mockReturnValueOnce({
                  limit: vi.fn().mockResolvedValueOnce([mockApptRecord]),
                }),
              }),
            }),
          }),
        update: vi.fn().mockReturnValueOnce({
          set: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              returning: vi.fn().mockResolvedValueOnce([
                { id: appointmentId, status: 'cancelled', updatedAt: new Date() },
              ]),
            }),
          }),
        }),
      };

      (db.transaction as any).mockImplementationOnce(async (cb: any) => cb(mockTx));

      // Instantiate service WITHOUT payments service
      const serviceWithoutPayments = new AppointmentsService(
        mockDoctors as never,
        undefined,
        mockNotifications,
        undefined,
      );

      await expect(
        serviceWithoutPayments.cancel(appointmentId, patientActor),
      ).rejects.toThrow('PaymentsService is required to process refund');
    });

    it('correctly maps Refund Failed in resolvePaymentStatusDisplay', () => {
      const result = resolvePaymentStatusDisplay(
        {
          status: 'captured',
          amountPaise: 90000,
          refundedAmountPaise: 0,
        },
        { status: 'failed' },
      );
      expect(result.statusDisplay).toBe('Refund Failed');
    });

    it('reconciles pending refund on patient listMine dashboard refresh', async () => {
      const mockReconciliation = {
        reconcilePendingRefund: vi.fn().mockResolvedValue(true),
      };

      const service = new AppointmentsService(
        mockDoctors as never,
        undefined,
        mockNotifications,
        mockPayments,
        mockReconciliation as any,
      );

      const mockApptRow = {
        id: appointmentId,
        startsAt: new Date(),
        endsAt: new Date(),
        status: 'cancelled',
        holdExpiresAt: null,
        doctor: { id: 'doc-1', name: 'Dr. Jane', specialty: 'General', bio: null },
        payment: {
          id: paymentId,
          status: 'captured',
          amountPaise: 90000,
          currency: 'INR',
          razorpayPaymentId: 'pay_123',
          refundedAmountPaise: 0,
        },
      };

      const mockQuery = {
        from: vi.fn().mockReturnThis(),
        innerJoin: vi.fn().mockReturnThis(),
        leftJoin: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([mockApptRow]),
      };
      (db.select as any) = vi.fn().mockReturnValue(mockQuery);

      // Subsequent db.select calls inside listMine for refunds and refreshed payment
      const mockRefundRow = {
        id: 'ref-1',
        paymentId,
        status: 'pending',
        amountPaise: 90000,
        currency: 'INR',
        arn: null,
        createdAt: new Date(),
      };
      const mockProcessedRefundRow = {
        ...mockRefundRow,
        status: 'processed',
        arn: 'ARN_PROCESSED_123',
      };
      const mockRefreshedPayment = {
        id: paymentId,
        status: 'refunded',
        amountPaise: 90000,
        currency: 'INR',
        razorpayPaymentId: 'pay_123',
        refundedAmountPaise: 90000,
      };

      mockQuery.where
        .mockResolvedValueOnce([mockApptRow]) // appointments query
        .mockResolvedValueOnce([mockRefundRow]) // initial refunds query with pending refund
        .mockResolvedValueOnce([mockProcessedRefundRow]) // refreshed refunds query
        .mockResolvedValueOnce([mockRefreshedPayment]); // refreshed payments query

      const appts = await service.listMine(patientActor);
      expect(mockReconciliation.reconcilePendingRefund).toHaveBeenCalledWith(mockRefundRow);
      expect(appts[0].payment?.statusDisplay).toBe('Refunded');
    });
  });

  describe('Schedule-change fallback cancellation', () => {
    it('allows an explicit cancellation before approval when an affected appointment has no alternatives', async () => {
      const service = new AppointmentsService(mockDoctors as never);
      const request = {
        id: 'request-no-alternatives', doctorId, status: 'pending', approvedAt: null,
        expiresAt: new Date(Date.now() + 86_400_000),
      };
      const affected = {
        id: 'affected-no-alternatives', requestId: request.id, appointmentId,
        consentStatus: 'pending', resolutionStatus: 'pending',
      };
      const results = [[], [affected], [request], [affected]];
      const tx = {
        select: vi.fn(() => {
          const result = results.shift() ?? [];
          const builder: any = {
            from: vi.fn(() => builder), where: vi.fn(() => builder), for: vi.fn(() => builder),
            limit: vi.fn(() => builder), then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
          };
          return builder;
        }),
        update: vi.fn(() => ({
          set: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(),
          returning: vi.fn().mockResolvedValue([{ ...affected, consentStatus: 'declined', resolutionStatus: 'cancelled' }]),
        })),
        insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
      };
      vi.spyOn(service as any, 'cancelAppointmentInTransaction').mockResolvedValue({
        updated: { id: appointmentId, status: 'cancelled' },
        record: { patientId, doctorId }, paymentIdToRefund: null, remainingPaise: 0,
      });
      (db.transaction as any).mockImplementationOnce(async (callback: any) => callback(tx));

      const result = await service.cancelUnresolvedScheduleChange(
        request.id, affected.id, doctorId, 'No valid schedule-change alternative is available.',
      );

      expect(result.scheduleChangeAppointment).toMatchObject({
        consentStatus: 'declined', resolutionStatus: 'cancelled',
      });
      expect((service as any).cancelAppointmentInTransaction).toHaveBeenCalledWith(tx, appointmentId, expect.objectContaining({
        id: doctorId, role: 'doctor',
      }));
    });

    it('uses one transaction and refuses an already-resolved affected appointment', async () => {
      const service = new AppointmentsService(mockDoctors as never);
      const results = [
        [{}],
        [{ appointmentId }],
        [{
          id: 'request-1',
          doctorId,
          status: 'pending',
          approvedAt: new Date(),
          expiresAt: new Date(Date.now() + 86_400_000),
        }],
        [{
          id: 'affected-1',
          requestId: 'request-1',
          appointmentId,
          consentStatus: 'accepted',
          resolutionStatus: 'rescheduled',
        }],
      ];
      const tx = {
        select: vi.fn(() => {
          const result = results.shift() ?? [];
          const builder: any = {
            from: vi.fn(() => builder),
            where: vi.fn(() => builder),
            for: vi.fn(() => builder),
            limit: vi.fn(() => builder),
            then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
          };
          return builder;
        }),
        update: vi.fn(),
        insert: vi.fn(),
      };
      (db.transaction as any).mockImplementationOnce(async (callback: any) => callback(tx));

      await expect(service.cancelUnresolvedScheduleChange(
        'request-1',
        'affected-1',
        doctorId,
        'Doctor cancellation fallback',
      )).rejects.toThrow('Only unresolved appointments in a pending request can be cancelled.');

      expect(db.transaction).toHaveBeenCalledTimes(1);
      expect(tx.update).not.toHaveBeenCalled();
      expect(tx.insert).not.toHaveBeenCalled();
    });
  });

  describe('Schedule-change acceptance', () => {
    it('reschedules the existing appointment after consent without changing its payment association', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2027-01-01T00:00:00.000Z'));
      const request = {
        id: 'request-accepted', doctorId, status: 'pending', approvedAt: new Date('2026-12-31T00:00:00.000Z'),
        expiresAt: new Date('2027-01-02T00:00:00.000Z'),
        proposedSchedule: {
          timezone: 'UTC', activeDays: [1, 2, 3, 4, 5], startHour: 9, endHour: 10,
          slotDurationMinutes: 15, schedulingMode: 'stream', capacity: 1, breakStart: null, breakEnd: null,
        },
      };
      const affected = {
        id: 'affected-accepted', requestId: request.id, appointmentId,
        originalStartsAt: new Date('2027-01-04T09:30:00.000Z'),
        originalEndsAt: new Date('2027-01-04T09:45:00.000Z'),
        consentStatus: 'pending', resolutionStatus: 'pending',
      };
      const alternative = {
        id: 'alternative-accepted', affectedAppointmentId: affected.id,
        startsAt: new Date('2027-01-04T09:00:00.000Z'), endsAt: new Date('2027-01-04T09:15:00.000Z'),
      };
      const record = {
        id: appointmentId, patientId, doctorId, startsAt: affected.originalStartsAt,
        endsAt: affected.originalEndsAt, status: 'scheduled', reminderGeneration: 0,
      };
      const updated = { ...record, startsAt: alternative.startsAt, endsAt: alternative.endsAt, reminderGeneration: 1 };
      const results = [
        [{ appointmentId }], [{ doctorId }], [], [request], [affected], [], [record], [alternative],
        [{ capacity: 1 }], [], [],
      ];
      const tx = {
        select: vi.fn(() => {
          const result = results.shift() ?? [];
          const builder: any = {
            from: vi.fn(() => builder), where: vi.fn(() => builder), for: vi.fn(() => builder),
            limit: vi.fn(() => builder), then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
          };
          return builder;
        }),
        update: vi.fn((target: unknown) => ({
          set: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(),
          returning: vi.fn().mockResolvedValue(target === payment
            ? []
            : tx.update.mock.calls.length === 1
              ? [updated]
              : [{ ...affected, consentStatus: 'accepted', resolutionStatus: 'rescheduled' }]),
        })),
        insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
      };
      const scheduleService = {
        getScheduleConfigForDoctor: vi.fn().mockResolvedValue(request.proposedSchedule),
        finalizeScheduleRequest: vi.fn().mockResolvedValue({ status: 'published' }),
      };
      const notificationsMock = {
        createNotification: vi.fn().mockResolvedValue({}),
      };
      const service = new AppointmentsService(mockDoctors as never, scheduleService as never, notificationsMock as never);
      (db.transaction as any).mockImplementationOnce(async (callback: any) => callback(tx));

      try {
        const result = await service.acceptScheduleChange(request.id, affected.id, alternative.id, patientId);

        expect(result.id).toBe(appointmentId);
        expect(result.startsAt).toEqual(alternative.startsAt);
        expect(result.endsAt).toEqual(alternative.endsAt);
        expect(tx.update).not.toHaveBeenCalledWith(payment);
        expect(scheduleService.finalizeScheduleRequest).toHaveBeenCalledWith(doctorId, request.id);
        expect(notificationsMock.createNotification).toHaveBeenCalledTimes(1);
        expect(notificationsMock.createNotification).toHaveBeenCalledWith(expect.objectContaining({
          userId: doctorId,
          title: 'Patient accepted a schedule alternative',
          message: `The patient accepted a new time for appointment ${appointmentId}.`,
          type: 'reschedule',
          appointmentId,
          scheduleRequestId: request.id,
        }));
      } finally {
        vi.useRealTimers();
      }
    });

    it('validates alternative capacity against the proposed schedule capacity rather than published capacity', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2027-01-01T00:00:00.000Z'));
      const request = {
        id: 'request-capacity-test', doctorId, status: 'pending', approvedAt: new Date('2026-12-31T00:00:00.000Z'),
        expiresAt: new Date('2027-01-02T00:00:00.000Z'),
        proposedSchedule: {
          timezone: 'UTC', activeDays: [1, 2, 3, 4, 5], startHour: 9, endHour: 10,
          slotDurationMinutes: 15, schedulingMode: 'stream', capacity: 1, breakStart: null, breakEnd: null,
        },
      };
      const affected = {
        id: 'affected-cap', requestId: request.id, appointmentId,
        originalStartsAt: new Date('2027-01-04T09:30:00.000Z'),
        originalEndsAt: new Date('2027-01-04T09:45:00.000Z'),
        consentStatus: 'pending', resolutionStatus: 'pending',
      };
      const alternative = {
        id: 'alt-cap', affectedAppointmentId: affected.id,
        startsAt: new Date('2027-01-04T09:00:00.000Z'), endsAt: new Date('2027-01-04T09:15:00.000Z'),
      };
      const record = {
        id: appointmentId, patientId, doctorId, startsAt: affected.originalStartsAt,
        endsAt: affected.originalEndsAt, status: 'scheduled', reminderGeneration: 0,
      };
      // Published capacity query returns 3 (old published capacity was 3)
      // Occupied returns 1 existing appointment in alternative slot
      // With proposed capacity = 1, 1 >= 1 should trigger ConflictException
      const results = [
        [{ appointmentId }], [{ doctorId }], [], [request], [affected], [], [record], [alternative],
        [{ capacity: 3 }], [], [{ id: 'other-booked-appt' }],
      ];
      const tx = {
        select: vi.fn(() => {
          const result = results.shift() ?? [];
          const builder: any = {
            from: vi.fn(() => builder), where: vi.fn(() => builder), for: vi.fn(() => builder),
            limit: vi.fn(() => builder), then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
          };
          return builder;
        }),
        update: vi.fn(),
        insert: vi.fn(),
      };
      const scheduleService = {
        getScheduleConfigForDoctor: vi.fn().mockResolvedValue(request.proposedSchedule),
        finalizeScheduleRequest: vi.fn(),
      };
      const service = new AppointmentsService(mockDoctors as never, scheduleService as never);
      (db.transaction as any).mockImplementationOnce(async (callback: any) => callback(tx));

      try {
        await expect(service.acceptScheduleChange(request.id, affected.id, alternative.id, patientId))
          .rejects.toThrow('The selected alternative has reached capacity.');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('Schedule-change expiration and locking', () => {
    it('locks doctor capacity before the appointment row during ordinary rescheduling', async () => {
      const record = {
        id: appointmentId, patientId, doctorId, status: 'scheduled',
        startsAt: new Date('2027-01-04T09:00:00.000Z'), endsAt: new Date('2027-01-04T09:15:00.000Z'),
      };
      const results = [[{ doctorId }], [], [record]];
      const builders: any[] = [];
      const tx = {
        select: vi.fn(() => {
          const result = results.shift() ?? [];
          const builder: any = {
            from: vi.fn(() => builder), where: vi.fn(() => builder),
            for: vi.fn(() => builder), limit: vi.fn(() => builder),
            then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
          };
          builders.push(builder);
          return builder;
        }),
      };
      (db.transaction as any).mockImplementationOnce(async (callback: any) => callback(tx));

      const result = await appointmentsService.reschedule(appointmentId, patientActor, {
        startsAt: record.startsAt, endsAt: record.endsAt,
      });

      expect(result).toEqual(record);
      expect(builders[1].for).toHaveBeenCalledWith('update');
      expect(builders[2].for).toHaveBeenCalledWith('update');
      expect(builders[1].for.mock.invocationCallOrder[0]).toBeLessThan(builders[2].for.mock.invocationCallOrder[0]);
    });

    it('expires pending requests and unresolved children without changing appointments or payments', async () => {
      const expiryService = new AppointmentExpiryService();
      const now = new Date('2027-01-02T00:00:00.000Z');
      const results = [
        [{ id: 'request-expired', doctorId }], [], [{ id: 'request-expired' }], [{ id: 'affected-pending' }],
      ];
      const tx: any = {
        select: vi.fn(() => {
          const result = results.shift() ?? [];
          const builder: any = {
            from: vi.fn(() => builder), where: vi.fn(() => builder), for: vi.fn(() => builder),
            limit: vi.fn(() => builder), then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
          };
          return builder;
        }),
        update: vi.fn()
          .mockReturnValueOnce({
            set: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(),
            returning: vi.fn().mockResolvedValue([{ id: 'request-expired' }]),
          })
          .mockReturnValueOnce({
            set: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue(undefined),
          }),
      };
      (db.transaction as any).mockImplementationOnce(async (callback: any) => callback(tx));

      const count = await expiryService.cleanupExpiredScheduleChangeRequests(now);

      expect(count).toBe(1);
      expect(tx.update).toHaveBeenCalledTimes(2);
      expect(tx.update).not.toHaveBeenCalledWith(appointment);
      expect(tx.update).not.toHaveBeenCalledWith(payment);
      expect(tx.update.mock.results[1].value.set).toHaveBeenCalledWith(expect.objectContaining({
        consentStatus: 'expired', resolutionStatus: 'expired', resolvedAt: now,
      }));
    });

    it('does not overwrite a patient response that wins the expiry race', async () => {
      const expiryService = new AppointmentExpiryService();
      const results = [[{ id: 'request-race', doctorId }], [], []];
      const tx: any = {
        select: vi.fn(() => {
          const result = results.shift() ?? [];
          const builder: any = {
            from: vi.fn(() => builder), where: vi.fn(() => builder), for: vi.fn(() => builder),
            limit: vi.fn(() => builder), then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
          };
          return builder;
        }),
        update: vi.fn(),
      };
      (db.transaction as any).mockImplementationOnce(async (callback: any) => callback(tx));

      const count = await expiryService.cleanupExpiredScheduleChangeRequests(new Date('2027-01-02T00:00:00.000Z'));

      expect(count).toBe(0);
      expect(tx.update).not.toHaveBeenCalled();
    });

    it('rejects patient schedule-change acceptance when the request has expired', async () => {
      const now = new Date('2027-01-02T12:00:00.000Z');
      vi.useFakeTimers();
      vi.setSystemTime(now);
      const expiredRequest = {
        id: 'request-expired-race',
        doctorId,
        status: 'pending',
        approvedAt: new Date('2027-01-01T00:00:00.000Z'),
        expiresAt: new Date('2027-01-02T10:00:00.000Z'), // expired 2 hours ago
      };
      const results = [
        [{ appointmentId }], // candidate affected row
        [{ doctorId }], // candidate appointment doctorId
        [], // doctor profile lock
        [expiredRequest], // request locked for update
      ];
      const tx = {
        select: vi.fn(() => {
          const result = results.shift() ?? [];
          const builder: any = {
            from: vi.fn(() => builder), where: vi.fn(() => builder), for: vi.fn(() => builder),
            limit: vi.fn(() => builder), then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
          };
          return builder;
        }),
        update: vi.fn(),
      };
      (db.transaction as any).mockImplementationOnce(async (callback: any) => callback(tx));

      try {
        await expect(
          appointmentsService.acceptScheduleChange('request-expired-race', 'affected-1', 'alt-1', patientId)
        ).rejects.toThrow(ConflictException);
      } finally {
        vi.useRealTimers();
      }
    });

    it('locks doctor capacity before the appointment row during schedule-change acceptance', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2027-01-01T00:00:00.000Z'));
      const validRequest = {
        id: 'request-lock-order', doctorId, status: 'pending', approvedAt: new Date('2026-12-31T00:00:00.000Z'),
        expiresAt: new Date('2027-01-02T00:00:00.000Z'),
        proposedSchedule: {
          timezone: 'UTC', activeDays: [1, 2, 3, 4, 5], startHour: 9, endHour: 10,
          slotDurationMinutes: 15, schedulingMode: 'stream', capacity: 1, breakStart: null, breakEnd: null,
        },
      };
      const affected = {
        id: 'affected-lock-order', requestId: validRequest.id, appointmentId,
        originalStartsAt: new Date('2027-01-04T09:30:00.000Z'),
        originalEndsAt: new Date('2027-01-04T09:45:00.000Z'),
        consentStatus: 'pending', resolutionStatus: 'pending',
      };
      const alternative = {
        id: 'alt-lock-order', affectedAppointmentId: affected.id,
        startsAt: new Date('2027-01-04T09:00:00.000Z'), endsAt: new Date('2027-01-04T09:15:00.000Z'),
      };
      const record = {
        id: appointmentId, patientId, doctorId, startsAt: affected.originalStartsAt,
        endsAt: affected.originalEndsAt, status: 'scheduled', reminderGeneration: 0,
      };
      const updated = { ...record, startsAt: alternative.startsAt, endsAt: alternative.endsAt, reminderGeneration: 1 };
      const results = [
        [{ appointmentId }], [{ doctorId }], [], [validRequest], [affected], [], [record], [alternative],
        [{ capacity: 1 }], [], [],
      ];
      const builders: any[] = [];
      const tx = {
        select: vi.fn(() => {
          const result = results.shift() ?? [];
          const builder: any = {
            from: vi.fn(() => builder), where: vi.fn(() => builder), for: vi.fn(() => builder),
            limit: vi.fn(() => builder), then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
          };
          builders.push(builder);
          return builder;
        }),
        update: vi.fn((target: unknown) => ({
          set: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(),
          returning: vi.fn().mockResolvedValue(target === payment ? [] : [updated]),
        })),
        insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
      };
      const scheduleService = {
        getScheduleConfigForDoctor: vi.fn().mockResolvedValue(validRequest.proposedSchedule),
        finalizeScheduleRequest: vi.fn().mockResolvedValue({ status: 'published' }),
      };
      const service = new AppointmentsService(mockDoctors as never, scheduleService as never);
      (db.transaction as any).mockImplementationOnce(async (callback: any) => callback(tx));

      try {
        await service.acceptScheduleChange(validRequest.id, affected.id, alternative.id, patientId);
        // Doctor capacity lock is index 2, appointment row lock is index 6
        expect(builders[2].for).toHaveBeenCalledWith('update');
        expect(builders[6].for).toHaveBeenCalledWith('update');
        expect(builders[2].for.mock.invocationCallOrder[0]).toBeLessThan(builders[6].for.mock.invocationCallOrder[0]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('handleCron runs periodic cleanup sweeps for both holds and schedule change requests', async () => {
      const expiryService = new AppointmentExpiryService();
      const holdSpy = vi.spyOn(expiryService, 'cleanupExpiredHolds').mockResolvedValue(3);
      const reqSpy = vi.spyOn(expiryService, 'cleanupExpiredScheduleChangeRequests').mockResolvedValue(2);

      await expiryService.handleCron();

      expect(holdSpy).toHaveBeenCalledOnce();
      expect(reqSpy).toHaveBeenCalledOnce();
    });
  });

  describe('Patient schedule-change history', () => {
    it('returns an approved request after it is resolved or its response deadline passes', async () => {
      const request = {
        id: 'request-history',
        doctorId,
        status: 'published',
        approvedAt: new Date('2026-10-01T00:00:00.000Z'),
        expiresAt: new Date('2026-10-02T00:00:00.000Z'),
      };
      const affected = {
        affected: {
          id: 'affected-history',
          requestId: request.id,
          consentStatus: 'accepted',
          resolutionStatus: 'rescheduled',
        },
        appointment: {
          id: appointmentId,
          startsAt: new Date('2026-12-01T10:00:00.000Z'),
          endsAt: new Date('2026-12-01T10:15:00.000Z'),
          status: 'scheduled',
        },
      };
      const makeQuery = (result: unknown) => {
        const builder: any = {
          from: vi.fn(() => builder),
          innerJoin: vi.fn(() => builder),
          where: vi.fn(() => builder),
          limit: vi.fn(() => builder),
          then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
            Promise.resolve(result).then(resolve, reject),
        };
        return builder;
      };
      vi.mocked(db.select)
        .mockImplementationOnce(() => makeQuery([request]) as never)
        .mockImplementationOnce(() => makeQuery([affected]) as never)
        .mockImplementationOnce(() => makeQuery([]) as never);

      const result = await appointmentsService.getScheduleChangeRequestForPatient(request.id, patientId);

      expect(result.request.status).toBe('published');
      expect(result.affectedAppointments[0]?.consentStatus).toBe('accepted');
      expect(result.affectedAppointments[0]?.appointment.id).toBe(appointmentId);
    });

    it('lists durable request history through appointments owned by the patient', async () => {
      const request = {
        id: 'request-history-list',
        doctorId,
        status: 'published',
        approvedAt: new Date('2026-10-01T00:00:00.000Z'),
        expiresAt: new Date('2026-10-02T00:00:00.000Z'),
      };
      const affected = {
        affected: { id: 'affected-history-list', requestId: request.id, consentStatus: 'declined', resolutionStatus: 'cancelled' },
        appointment: { id: appointmentId, startsAt: new Date(), endsAt: new Date(Date.now() + 900_000), status: 'scheduled' },
      };
      const makeQuery = (result: unknown) => {
        const builder: any = {
          from: vi.fn(() => builder),
          innerJoin: vi.fn(() => builder),
          where: vi.fn(() => builder),
          orderBy: vi.fn(() => builder),
          limit: vi.fn(() => builder),
          then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
            Promise.resolve(result).then(resolve, reject),
        };
        return builder;
      };
      const eligibilityQuery = makeQuery([{ requestId: request.id }]);
      vi.mocked(db.select)
        .mockImplementationOnce(() => eligibilityQuery as never)
        .mockImplementationOnce(() => makeQuery([request]) as never)
        .mockImplementationOnce(() => makeQuery([affected]) as never)
        .mockImplementationOnce(() => makeQuery([]) as never);

      const result = await appointmentsService.listScheduleChangeRequestsForPatient(patientId);

      expect(eligibilityQuery.where).toHaveBeenCalledOnce();
      expect(result).toHaveLength(1);
      expect(result[0]?.request.status).toBe('published');
      expect(result[0]?.affectedAppointments[0]?.consentStatus).toBe('declined');
      expect(result[0]?.affectedAppointments[0]?.appointment.id).toBe(appointmentId);
    });
  });
});
