import { NotFoundException } from '@nestjs/common';
import { PatientsService } from './patients.service.js';
import { db } from '../db/database.js';

vi.mock('../db/database.js', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
  },
}));

describe('PatientsService - patient profile management', () => {
  let service: PatientsService;

  beforeEach(() => {
    service = new PatientsService();
    vi.clearAllMocks();
  });

  describe('getOwn', () => {
    it('returns combined user and patient profile information', async () => {
      const patientId = 'patient-123';
      const mockUser = {
        id: patientId,
        name: 'Alex Patient',
        email: 'alex@example.test',
        image: 'https://images.example.test/alex.jpg',
      };
      const mockPatientProfile = {
        dateOfBirth: '1990-01-15',
        gender: 'other',
        phone: '+919876543210',
        bloodGroup: 'B+',
        address: '456 Marine Drive, Mumbai',
        allergies: 'Penicillin',
      };

      (db.select as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              limit: vi.fn().mockResolvedValueOnce([mockUser]),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              limit: vi.fn().mockResolvedValueOnce([mockPatientProfile]),
            }),
          }),
        });

      const profile = await service.getOwn(patientId);
      expect(profile).toEqual({
        id: patientId,
        name: 'Alex Patient',
        email: 'alex@example.test',
        image: 'https://images.example.test/alex.jpg',
        dateOfBirth: '1990-01-15',
        gender: 'other',
        phone: '+919876543210',
        bloodGroup: 'B+',
        address: '456 Marine Drive, Mumbai',
        allergies: 'Penicillin',
      });
    });

    it('returns nulls for profile fields when patient has not set them yet', async () => {
      const patientId = 'patient-123';
      const mockUser = {
        id: patientId,
        name: 'New Patient',
        email: 'new@example.test',
        image: null,
      };

      (db.select as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              limit: vi.fn().mockResolvedValueOnce([mockUser]),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              limit: vi.fn().mockResolvedValueOnce([]), // no patient_profile record yet
            }),
          }),
        });

      const profile = await service.getOwn(patientId);
      expect(profile).toEqual({
        id: patientId,
        name: 'New Patient',
        email: 'new@example.test',
        image: null,
        dateOfBirth: null,
        gender: null,
        phone: null,
        bloodGroup: null,
        address: null,
        allergies: null,
      });
    });

    it('throws NotFoundException when patient account does not exist', async () => {
      (db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnValueOnce({
          where: vi.fn().mockReturnValueOnce({
            limit: vi.fn().mockResolvedValueOnce([]),
          }),
        }),
      });

      await expect(service.getOwn('non-existent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateOwn', () => {
    it('updates user and upserts patient profile fields', async () => {
      const patientId = 'patient-123';
      const updatedUser = {
        id: patientId,
        name: 'Alex Updated',
        email: 'alex@example.test',
        image: 'https://images.example.test/new.jpg',
      };

      // 1. db.update(user)
      (db.update as any).mockReturnValueOnce({
        set: vi.fn().mockReturnValueOnce({
          where: vi.fn().mockReturnValueOnce({
            returning: vi.fn().mockResolvedValueOnce([updatedUser]),
          }),
        }),
      });

      // 2. db.select(patientProfile) to check existing
      (db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnValueOnce({
          where: vi.fn().mockReturnValueOnce({
            limit: vi.fn().mockResolvedValueOnce([{ id: 'profile-uuid' }]),
          }),
        }),
      });

      // 3. db.update(patientProfile)
      (db.update as any).mockReturnValueOnce({
        set: vi.fn().mockReturnValueOnce({
          where: vi.fn().mockResolvedValueOnce([]),
        }),
      });

      // 4. getOwn call after update
      (db.select as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              limit: vi.fn().mockResolvedValueOnce([updatedUser]),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValueOnce({
            where: vi.fn().mockReturnValueOnce({
              limit: vi.fn().mockResolvedValueOnce([{
                dateOfBirth: '1992-06-20',
                gender: 'male',
                phone: '+919876543210',
                bloodGroup: 'A+',
                address: 'New Address',
                allergies: 'None',
              }]),
            }),
          }),
        });

      const result = await service.updateOwn(patientId, {
        name: 'Alex Updated',
        image: 'https://images.example.test/new.jpg',
        dateOfBirth: '1992-06-20',
        gender: 'male',
        phone: '+919876543210',
        bloodGroup: 'A+',
        address: 'New Address',
        allergies: 'None',
      });

      expect(result.name).toBe('Alex Updated');
      expect(result.dateOfBirth).toBe('1992-06-20');
      expect(result.bloodGroup).toBe('A+');
    });

    it('falls back to resilient cache when patientProfile table is pending migration', async () => {
      const patientId = 'patient-fallback';
      const updatedUser = {
        id: patientId,
        name: 'Fallback User',
        email: 'fallback@example.test',
        image: null,
      };

      // 1. db.update(user) succeeds
      (db.update as any).mockReturnValueOnce({
        set: vi.fn().mockReturnValueOnce({
          where: vi.fn().mockReturnValueOnce({
            returning: vi.fn().mockResolvedValueOnce([updatedUser]),
          }),
        }),
      });

      // 2. db.select(patientProfile) throws relation error (table not migrated)
      (db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnValueOnce({
          where: vi.fn().mockReturnValueOnce({
            limit: vi.fn().mockRejectedValueOnce(new Error('relation "patient_profile" does not exist')),
          }),
        }),
      });

      // 3. getOwn user select succeeds
      (db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnValueOnce({
          where: vi.fn().mockReturnValueOnce({
            limit: vi.fn().mockResolvedValueOnce([updatedUser]),
          }),
        }),
      });

      // 4. getOwn patientProfile select throws relation error
      (db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnValueOnce({
          where: vi.fn().mockReturnValueOnce({
            limit: vi.fn().mockRejectedValueOnce(new Error('relation "patient_profile" does not exist')),
          }),
        }),
      });

      const result = await service.updateOwn(patientId, {
        phone: '+911234567890',
        bloodGroup: 'O-',
      });

      expect(result.phone).toBe('+911234567890');
      expect(result.bloodGroup).toBe('O-');
    });
  });
});
