import { NotFoundException } from '@nestjs/common';
import { PatientsService } from './patients.service.js';
import { db } from '../db/database.js';

vi.mock('../db/database.js', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    transaction: vi.fn(),
  },
}));

describe('PatientsService - patient profile management', () => {
  let service: PatientsService;

  beforeEach(() => {
    service = new PatientsService();
    vi.resetAllMocks();
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
        medicalRevision: 0,
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
        medicalRevision: 0,
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
        medicalRevision: 0,
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

describe('medical updates', () => {
  const patient = { id: 'patient-1', role: 'patient', name: 'Patient', email: 'p@example.test' } as const;
  const service = new PatientsService();
  let profile: { id: string; allergies: string | null; medicalConditions: string | null; medicalRevision: number };
  let audit: unknown[];
  let failAudit: boolean;
  const txSelect = vi.fn();
  const txUpdate = vi.fn();
  const txInsert = vi.fn();
  beforeEach(() => {
    vi.resetAllMocks();
    profile = { id: 'profile', allergies: 'old', medicalConditions: null, medicalRevision: 1 };
    audit = []; failAudit = false;
    txSelect.mockImplementation(() => ({ from: () => ({ where: () => ({ for: () => ({ limit: async () =>
      txSelect.mock.calls.length % 2 ? [{ id: patient.id }] : [{ ...profile }] }) }) }) }));
    txUpdate.mockImplementation(() => ({ set: (fields: typeof profile) => ({ where: async () => { profile = { ...profile, ...fields }; } }) }));
    txInsert.mockImplementation(() => ({ values: async (value: unknown) => { if (failAudit) throw new Error('audit failed'); audit.push(value); } }));
    vi.mocked(db.transaction).mockImplementation(async callback => {
      const original = { ...profile }; const oldAudit = [...audit];
      try { return await callback({ select: txSelect, update: txUpdate, insert: txInsert } as never); }
      catch (error) { profile = original; audit = oldAudit; throw error; }
    });
    vi.spyOn(service, 'getMedical').mockResolvedValue({ allergies: null, conditions: null, revision: 0, history: [] });
  });
  it('records the old and new values with the actor', async () => {
    await service.updateMedical(patient, { allergies: 'new', conditions: 'asthma', revision: 1 });
    expect(profile.medicalRevision).toBe(2);
    expect(audit).toEqual([expect.objectContaining({ patientId: patient.id, actorId: patient.id, actorRole: 'patient',
      changes: { allergies: { before: 'old', after: 'new' }, conditions: { before: null, after: 'asthma' } } })]);
  });
  it('rolls back the profile when the audit write fails', async () => {
    failAudit = true;
    await expect(service.updateMedical(patient, { allergies: 'new', conditions: null, revision: 1 })).rejects.toThrow('audit failed');
    expect(profile.allergies).toBe('old'); expect(profile.medicalRevision).toBe(1); expect(audit).toEqual([]);
  });
  it('rejects stale revisions and does not write history', async () => {
    await expect(service.updateMedical(patient, { allergies: 'new', conditions: null, revision: 0 })).rejects.toThrow('Medical information changed');
    expect(txUpdate).not.toHaveBeenCalled(); expect(audit).toEqual([]);
  });
  it('rejects the second writer using an earlier revision', async () => {
    await service.updateMedical(patient, { allergies: 'first', conditions: null, revision: 1 });
    await expect(service.updateMedical(patient, { allergies: 'second', conditions: null, revision: 1 })).rejects.toThrow('Medical information changed');
    expect(profile.allergies).toBe('first'); expect(audit).toHaveLength(1);
  });
  it('does not log an unchanged update', async () => {
    await service.updateMedical(patient, { allergies: 'old', conditions: null, revision: 1 });
    expect(txUpdate).not.toHaveBeenCalled(); expect(audit).toEqual([]);
  });
  it('keeps legacy allergy saves durable and records the change', async () => {
    vi.spyOn(service, 'getOwn').mockResolvedValue({ id: patient.id, name: patient.name, email: patient.email, image: null,
      dateOfBirth: null, gender: null, phone: null, bloodGroup: null, address: null, allergies: 'new' });
    await service.updateOwn(patient.id, { allergies: 'new' }, 1);
    expect(profile.allergies).toBe('new');
    expect(audit).toEqual([expect.objectContaining({ actorId: patient.id, actorRole: 'patient',
      changes: { allergies: { before: 'old', after: 'new' } } })]);
  });
  it('rejects a legacy medical update if its audit fails', async () => {
    failAudit = true;
    await expect(service.updateOwn(patient.id, { allergies: 'new' }, 1)).rejects.toThrow('audit failed');
    expect(profile.allergies).toBe('old'); expect(audit).toEqual([]);
  });
  it('rejects missing or stale legacy revisions', async () => {
    await expect(service.updateOwn(patient.id, { allergies: 'new' })).rejects.toThrow('Reload your profile');
    await expect(service.updateOwn(patient.id, { allergies: 'new' }, 0)).rejects.toThrow('Medical information changed');
    expect(audit).toEqual([]);
  });
  it.each(['staff', 'admin'])('denies %s medical access without querying a patient', async role => {
    await expect(service.updateMedical({ ...patient, role } as never, { allergies: null, conditions: null, revision: 0 })).rejects.toThrow();
    expect(db.transaction).not.toHaveBeenCalled();
  });
  it('denies a doctor without an approved qualifying appointment', async () => {
    vi.mocked(db.select).mockReturnValue({ from: () => ({ innerJoin: () => ({ where: () => ({ limit: async () => [] }) }) }) } as never);
    await expect(service.updateMedical({ ...patient, id: 'doctor-2', role: 'doctor' },
      { allergies: null, conditions: null, revision: 0 }, 'appointment-1')).rejects.toThrow(NotFoundException);
    expect(db.transaction).not.toHaveBeenCalled();
  });
  it('allows the approved treating doctor after rechecking the appointment', async () => {
    vi.mocked(db.select).mockReturnValue({ from: () => ({ innerJoin: () => ({ where: () => ({ limit: async () => [{ patientId: patient.id }] }) }) }) } as never);
    txSelect.mockReset();
    txSelect.mockReturnValueOnce({ from: () => ({ where: () => ({ for: () => ({ limit: async () => [{ id: patient.id }] }) }) }) });
    txSelect.mockReturnValueOnce({ from: () => ({ innerJoin: () => ({ where: () => ({ for: () => ({ limit: async () => [{ id: 'appointment-1' }] }) }) }) }) });
    txSelect.mockReturnValueOnce({ from: () => ({ where: () => ({ for: () => ({ limit: async () => [{ ...profile }] }) }) }) });
    await service.updateMedical({ ...patient, id: 'doctor-1', role: 'doctor' },
      { allergies: 'new', conditions: null, revision: 1 }, 'appointment-1');
    expect(audit).toEqual([expect.objectContaining({ patientId: patient.id, actorId: 'doctor-1', actorRole: 'doctor', appointmentId: 'appointment-1' })]);
  });
});
