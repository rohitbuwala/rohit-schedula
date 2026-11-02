import { ConflictException } from '@nestjs/common';
import { AppointmentsService, resolvePaymentStatusDisplay } from './appointments.service.js';
import { PaymentReconciliationService } from '../payments/payment-reconciliation.service.js';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { db } from '../db/database.js';

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
    it('1. triggers an immediate full refund when a paid scheduled appointment is cancelled by patient', async () => {
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

      const result = await appointmentsService.cancel(appointmentId, patientActor);

      expect(result.status).toBe('cancelled');
      expect(result.refund).toBeDefined();
      expect(result.refund.status).toBe('processed');
      expect(mockPayments.refundPayment).toHaveBeenCalledWith(
        patientId,
        'system',
        paymentId,
        expect.objectContaining({
          reason: 'Appointment cancelled by patient',
          amountPaise: 50000,
        }),
      );
      expect(mockNotifications.createNotification).toHaveBeenCalled();
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
});
