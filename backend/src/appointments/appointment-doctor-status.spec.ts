import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AppointmentsService } from './appointments.service.js';
import { db } from '../db/database.js';

vi.mock('../db/database.js', () => ({
  db: {
    select: vi.fn(),
    transaction: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

describe('AppointmentsService with doctor approval/deactivation lifecycle', () => {
  let service: AppointmentsService;
  let mockDoctorsService: { isApproved: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockDoctorsService = {
      isApproved: vi.fn(),
    };
    service = new AppointmentsService(mockDoctorsService as any);
    vi.clearAllMocks();
  });

  describe('booking with deactivated or unapproved doctor', () => {
    it('rejects booking when doctor is not approved / deactivated', async () => {
      // findApprovedDoctor returns empty (doctorProfile not approved)
      (db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnValueOnce({
          innerJoin: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              limit: vi.fn().mockResolvedValueOnce([]),
            }),
          }),
        }),
      });

      await expect(
        service.createForPatient('patient-1', {
          doctorProfileId: '00000000-0000-4000-8000-000000000001',
          startsAt: new Date(Date.now() + 3600000),
          endsAt: new Date(Date.now() + 5400000),
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects available slot queries when doctor is deactivated', async () => {
      (db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnValueOnce({
          innerJoin: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              limit: vi.fn().mockResolvedValueOnce([]),
            }),
          }),
        }),
      });

      await expect(
        service.getAvailableSlots('patient-1', {
          doctorProfileId: '00000000-0000-4000-8000-000000000001',
          date: '2026-11-01',
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('rescheduling with deactivated doctor', () => {
    it('blocks rescheduling an appointment when doctor is no longer approved / deactivated', async () => {
      const appointmentId = '00000000-0000-4000-8000-000000000001';
      const patientId = 'patient-1';
      const doctorId = 'doctor-1';

      const existingAppointment = {
        id: appointmentId,
        patientId,
        doctorId,
        startsAt: new Date('2026-11-01T10:00:00Z'),
        endsAt: new Date('2026-11-01T10:30:00Z'),
        status: 'scheduled',
      };

      const txSelect = vi.fn().mockReturnValueOnce({
        from: vi.fn().mockReturnValueOnce({
          where: vi.fn().mockReturnValueOnce({
            for: vi.fn().mockReturnValueOnce({
              limit: vi.fn().mockResolvedValueOnce([existingAppointment]),
            }),
          }),
        }),
      });

      (db.transaction as any).mockImplementation(async (callback: any) => {
        return callback({ select: txSelect });
      });

      // Doctor is no longer approved
      mockDoctorsService.isApproved.mockResolvedValueOnce(false);

      await expect(
        service.reschedule(
          appointmentId,
          { id: patientId, role: 'patient' } as any,
          {
            startsAt: new Date('2026-11-02T10:00:00Z'),
            endsAt: new Date('2026-11-02T10:30:00Z'),
          },
        ),
      ).rejects.toThrow(ConflictException);

      expect(mockDoctorsService.isApproved).toHaveBeenCalledWith(doctorId);
    });
  });

  describe('appointment history preservation for patients', () => {
    it('preserves and returns patient appointment history even when doctor was deactivated', async () => {
      const mockPastAppointment = {
        id: '00000000-0000-4000-8000-000000000001',
        startsAt: new Date('2026-10-01T10:00:00Z'),
        endsAt: new Date('2026-10-01T10:30:00Z'),
        status: 'completed',
        doctor: {
          id: '00000000-0000-4000-8000-000000000002',
          name: 'Dr. Deactivated',
          specialty: 'Cardiology',
          bio: null,
        },
      };

      (db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnValueOnce({
          innerJoin: vi.fn().mockReturnValueOnce({
            innerJoin: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockResolvedValueOnce([mockPastAppointment]),
            }),
          }),
        }),
      });

      const results = await service.listMine({ id: 'patient-1', role: 'patient' } as any);
      expect(results).toHaveLength(1);
      expect(results[0].doctor.name).toBe('Dr. Deactivated');
      expect(results[0].status).toBe('completed');
    });
  });
});
