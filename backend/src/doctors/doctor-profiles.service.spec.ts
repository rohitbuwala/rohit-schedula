import { ConflictException, NotFoundException } from '@nestjs/common';
import { DoctorProfilesService } from './doctor-profiles.service.js';
import { db } from '../db/database.js';

vi.mock('../db/database.js', () => ({
  db: {
    select: vi.fn(),
    transaction: vi.fn(),
    delete: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
  },
}));

describe('DoctorProfilesService - deactivation and safe deletion', () => {
  let service: DoctorProfilesService;

  beforeEach(() => {
    service = new DoctorProfilesService();
    vi.clearAllMocks();
  });

  describe('deleteDoctor', () => {
    it('blocks permanent deletion and throws ConflictException when appointments exist', async () => {
      const profileId = '00000000-0000-4000-8000-000000000001';
      const doctorUserId = 'user-doctor-1';

      // 1. Profile lookup returns existing profile
      // 2. Appointment lookup returns existing appointment
      (db.select as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              limit: vi.fn().mockResolvedValueOnce([{ id: profileId, userId: doctorUserId }]),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              limit: vi.fn().mockResolvedValueOnce([{ id: 'appointment-123' }]),
            }),
          }),
        });

      await expect(service.deleteDoctor(profileId)).rejects.toThrow(
        'Cannot permanently delete doctor because appointments are associated with this doctor. Deactivate or unapprove the doctor instead to preserve medical appointment history.',
      );
    });

    it('blocks permanent deletion when the doctor has reviewed other applications', async () => {
      const profileId = '00000000-0000-4000-8000-000000000001';
      const doctorUserId = 'user-doctor-1';

      (db.select as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              limit: vi.fn().mockResolvedValueOnce([{ id: profileId, userId: doctorUserId }]),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              limit: vi.fn().mockResolvedValueOnce([]), // no appointments
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              limit: vi.fn().mockResolvedValueOnce([{ id: 'other-profile' }]), // reviewed another profile
            }),
          }),
        });

      await expect(service.deleteDoctor(profileId)).rejects.toThrow(
        'Cannot permanently delete doctor because this account has reviewed other doctor applications as an administrator. Deactivate the doctor instead.',
      );
    });

    it('throws NotFoundException if doctor profile does not exist', async () => {
      (db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnValueOnce({
          where: vi.fn().mockReturnValueOnce({
            limit: vi.fn().mockResolvedValueOnce([]),
          }),
        }),
      });

      await expect(service.deleteDoctor('non-existent-id')).rejects.toThrow(NotFoundException);
    });

    it('successfully deletes doctor profile and reverts user role to patient when no appointments exist', async () => {
      const profileId = '00000000-0000-4000-8000-000000000001';
      const doctorUserId = 'user-doctor-1';

      (db.select as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              limit: vi.fn().mockResolvedValueOnce([{ id: profileId, userId: doctorUserId }]),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              limit: vi.fn().mockResolvedValueOnce([]), // no appointments
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              limit: vi.fn().mockResolvedValueOnce([]), // no reviewed profiles
            }),
          }),
        });

      const txDelete = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) });
      const txUpdate = vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) });

      (db.transaction as any).mockImplementation(async (callback: any) => {
        return callback({ delete: txDelete, update: txUpdate });
      });

      const result = await service.deleteDoctor(profileId);
      expect(result).toEqual({ id: profileId, deleted: true, message: 'Doctor profile permanently deleted.' });
      expect(txDelete).toHaveBeenCalled();
      expect(txUpdate).toHaveBeenCalled();
    });
  });

  describe('deactivateDoctor & decide', () => {
    it('safely deactivates an approved doctor, changing status to rejected and role to patient', async () => {
      const applicationId = '00000000-0000-4000-8000-000000000001';
      const adminId = 'admin-user-1';
      const doctorUserId = 'doctor-user-1';

      const existingProfile = { id: applicationId, userId: doctorUserId, status: 'approved' };
      const existingUser = { id: doctorUserId, role: 'doctor' };
      const updatedProfile = { id: applicationId, userId: doctorUserId, status: 'rejected', reviewedAt: new Date() };

      const txSelect = vi.fn()
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              for: vi.fn().mockReturnValueOnce({
                limit: vi.fn().mockResolvedValueOnce([existingProfile]),
              }),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              limit: vi.fn().mockResolvedValueOnce([existingUser]),
            }),
          }),
        });

      const txUpdate = vi.fn()
        .mockReturnValueOnce({
          set: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              returning: vi.fn().mockResolvedValueOnce([updatedProfile]),
            }),
          }),
        })
        .mockReturnValueOnce({
          set: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockResolvedValueOnce([]),
          }),
        });

      (db.transaction as any).mockImplementation(async (callback: any) => {
        return callback({ select: txSelect, update: txUpdate });
      });

      const result = await service.deactivateDoctor(applicationId, adminId);
      expect(result.status).toBe('rejected');
      expect(txUpdate).toHaveBeenCalledTimes(2); // updates doctorProfile to 'rejected' and user role to 'patient'
    });

    it('re-approves and reactivates a previously rejected/deactivated doctor', async () => {
      const applicationId = '00000000-0000-4000-8000-000000000001';
      const adminId = 'admin-user-1';
      const doctorUserId = 'doctor-user-1';

      const existingProfile = { id: applicationId, userId: doctorUserId, status: 'rejected' };
      const existingUser = { id: doctorUserId, role: 'patient' };
      const updatedProfile = { id: applicationId, userId: doctorUserId, status: 'approved', reviewedAt: new Date() };

      const txSelect = vi.fn()
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              for: vi.fn().mockReturnValueOnce({
                limit: vi.fn().mockResolvedValueOnce([existingProfile]),
              }),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              limit: vi.fn().mockResolvedValueOnce([existingUser]),
            }),
          }),
        });

      const txUpdate = vi.fn()
        .mockReturnValueOnce({
          set: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              returning: vi.fn().mockResolvedValueOnce([updatedProfile]),
            }),
          }),
        })
        .mockReturnValueOnce({
          set: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockResolvedValueOnce([]),
          }),
        });

      (db.transaction as any).mockImplementation(async (callback: any) => {
        return callback({ select: txSelect, update: txUpdate });
      });

      const result = await service.decide(applicationId, adminId, 'approved');
      expect(result.status).toBe('approved');
      expect(txUpdate).toHaveBeenCalledTimes(2); // updates doctorProfile to 'approved' and user role to 'doctor'
    });
  });
});
