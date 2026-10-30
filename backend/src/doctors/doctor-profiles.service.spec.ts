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
  describe('updateOwnApprovedProfile', () => {
    it('updates practice fields for an approved doctor profile', async () => {
      const userId = 'approved-doc-user';
      const existingProfile = { id: 'profile-1', userId, status: 'approved' };
      const updatedProfile = {
        id: 'profile-1',
        userId,
        name: 'Dr. Jane',
        email: 'jane@example.com',
        specialty: 'Cardiology',
        licenseRegion: 'NMC',
        licenseNumber: 'NMC-12345',
        bio: 'Updated bio',
        phone: '+919876543210',
        qualifications: 'MBBS, MD',
        yearsOfExperience: 8,
        consultationFeeInr: 600,
        clinicName: 'Jane Clinic',
        clinicAddress: '123 Main St',
        profilePhotoUrl: null,
      };

      (db.select as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              limit: vi.fn().mockResolvedValueOnce([existingProfile]),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            innerJoin: vi.fn().mockReturnValueOnce({
              where: vi.fn().mockReturnValueOnce({
                limit: vi.fn().mockResolvedValueOnce([updatedProfile]),
              }),
            }),
          }),
        });

      (db.update as any).mockReturnValueOnce({
        set: vi.fn().mockReturnValueOnce({
          where: vi.fn().mockResolvedValueOnce([]),
        }),
      });

      const res = await service.updateOwnApprovedProfile(userId, {
        bio: 'Updated bio',
        consultationFeeInr: 600,
      });

      expect(res.bio).toBe('Updated bio');
      expect(res.isVerified).toBe(true);
      expect(res.status).toBe('approved');
      expect(db.update).toHaveBeenCalled();
    });

    it('throws NotFoundException when no approved profile exists for userId', async () => {
      (db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnValueOnce({
          where: vi.fn().mockReturnValueOnce({
            limit: vi.fn().mockResolvedValueOnce([]),
          }),
        }),
      });

      await expect(service.updateOwnApprovedProfile('unknown-user', { bio: 'test' })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('decide with notifications', () => {
    it('sends system notification to applicant on approval', async () => {
      const mockNotifications = { createNotification: vi.fn().mockResolvedValue({}) };
      const serviceWithNotifications = new DoctorProfilesService(mockNotifications as any);

      const applicationId = 'app-1';
      const adminId = 'admin-1';
      const applicantId = 'applicant-1';

      const existingProfile = { id: applicationId, userId: applicantId, status: 'pending' };
      const existingUser = { id: applicantId, role: 'patient' };
      const updatedProfile = { id: applicationId, userId: applicantId, status: 'approved', reviewedAt: new Date() };

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

      await serviceWithNotifications.decide(applicationId, adminId, 'approved');

      expect(mockNotifications.createNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: applicantId,
          title: expect.stringContaining('Approved'),
          type: 'system',
        }),
      );
    });
    it('sends system notification with rejection reason on rejection', async () => {
      const mockNotifications = { createNotification: vi.fn().mockResolvedValue({}) };
      const serviceWithNotifications = new DoctorProfilesService(mockNotifications as any);

      const applicationId = 'app-rejected-1';
      const adminId = 'admin-1';
      const applicantId = 'applicant-1';
      const reason = 'Registration number not found on state council records';

      const existingProfile = { id: applicationId, userId: applicantId, status: 'pending' };
      const existingUser = { id: applicantId, role: 'patient' };
      const updatedProfile = { id: applicationId, userId: applicantId, status: 'rejected', reviewedAt: new Date() };

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
        });

      (db.transaction as any).mockImplementation(async (callback: any) => {
        return callback({ select: txSelect, update: txUpdate });
      });

      const res = await serviceWithNotifications.decide(applicationId, adminId, 'rejected', reason);

      expect(res.status).toBe('rejected');
      expect(res.rejectionReason).toBe(reason);
      expect(mockNotifications.createNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: applicantId,
          title: expect.stringContaining('Doctor Application Status'),
          message: expect.stringContaining(reason),
          type: 'system',
        }),
      );
    });

    it('succeeds and does not corrupt application status if notification service throws an error', async () => {
      const mockNotifications = {
        createNotification: vi.fn().mockRejectedValue(new Error('Notification service down or timed out')),
      };
      const serviceWithNotifications = new DoctorProfilesService(mockNotifications as any);

      const applicationId = 'app-1';
      const adminId = 'admin-1';
      const applicantId = 'applicant-1';

      const existingProfile = { id: applicationId, userId: applicantId, status: 'pending' };
      const existingUser = { id: applicantId, role: 'patient' };
      const updatedProfile = { id: applicationId, userId: applicantId, status: 'approved', reviewedAt: new Date() };

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

      // Must resolve cleanly without throwing despite notification failure
      const result = await serviceWithNotifications.decide(applicationId, adminId, 'approved');
      expect(result.status).toBe('approved');
      expect(result.userId).toBe(applicantId);
      expect(mockNotifications.createNotification).toHaveBeenCalled();
    });
  });

  describe('doctor application resubmission', () => {
    it('allows a pending applicant to update their onboarding profile in place without creating a duplicate', async () => {
      const applicantId = 'applicant-pending';
      const existingProfile = { id: 'app-pend-1', userId: applicantId, status: 'pending' };
      const updatedProfile = {
        id: 'app-pend-1',
        userId: applicantId,
        specialty: 'Neurology',
        licenseRegion: 'NMC',
        licenseNumber: 'NMC-88888',
        bio: 'Updated pending bio',
        status: 'pending',
        submittedAt: new Date(),
        reviewedAt: null,
      };

      (db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnValueOnce({
          where: vi.fn().mockReturnValueOnce({
            limit: vi.fn().mockResolvedValueOnce([existingProfile]),
          }),
        }),
      });

      (db.update as any).mockReturnValueOnce({
        set: vi.fn().mockReturnValueOnce({
          where: vi.fn().mockReturnValueOnce({
            returning: vi.fn().mockResolvedValueOnce([updatedProfile]),
          }),
        }),
      });

      const res = await service.apply(applicantId, {
        specialty: 'Neurology',
        licenseRegion: 'NMC',
        licenseNumber: 'NMC-88888',
        bio: 'Updated pending bio',
      });

      expect(res.status).toBe('pending');
      expect(res.specialty).toBe('Neurology');
      expect(res.bio).toBe('Updated pending bio');
      expect(db.insert).not.toHaveBeenCalled();
      expect(db.update).toHaveBeenCalled();
    });
    it('resubmits application for a rejected doctor, resetting status to pending', async () => {
      const applicantId = 'applicant-rejected';
      const existingProfile = { id: 'app-rej-1', userId: applicantId, status: 'rejected' };
      const updatedProfile = {
        id: 'app-rej-1',
        userId: applicantId,
        specialty: 'Cardiology',
        licenseRegion: 'NMC',
        licenseNumber: 'NMC-99999',
        status: 'pending',
        submittedAt: new Date(),
        reviewedAt: null,
      };

      (db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnValueOnce({
          where: vi.fn().mockReturnValueOnce({
            limit: vi.fn().mockResolvedValueOnce([existingProfile]),
          }),
        }),
      });

      (db.update as any).mockReturnValueOnce({
        set: vi.fn().mockReturnValueOnce({
          where: vi.fn().mockReturnValueOnce({
            returning: vi.fn().mockResolvedValueOnce([updatedProfile]),
          }),
        }),
      });

      const res = await service.apply(applicantId, {
        specialty: 'Cardiology',
        licenseRegion: 'NMC',
        licenseNumber: 'NMC-99999',
      });

      expect(res.status).toBe('pending');
      expect(res.licenseNumber).toBe('NMC-99999');
      expect(res.rejectionReason).toBeNull();
    });

    it('blocks apply() when doctor profile is already approved', async () => {
      const applicantId = 'already-approved-doc';
      const existingProfile = { id: 'app-appr-1', userId: applicantId, status: 'approved' };

      (db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnValueOnce({
          where: vi.fn().mockReturnValueOnce({
            limit: vi.fn().mockResolvedValueOnce([existingProfile]),
          }),
        }),
      });

      await expect(
        service.apply(applicantId, {
          specialty: 'Cardiology',
          licenseRegion: 'NMC',
          licenseNumber: 'NMC-12345',
        }),
      ).rejects.toThrow(ConflictException);
    });
  });
});
