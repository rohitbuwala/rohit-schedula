import { doctorApplicationSchema, doctorDecisionSchema, doctorProfileUpdateSchema, toPublicDoctorProfile } from './doctor-profile.schema.js';

describe('doctor application validation', () => {
  it('accepts minimum license details and normalizes text', () => {
    const result = doctorApplicationSchema.parse({ specialty: '  Cardiology ', licenseRegion: ' CA ', licenseNumber: ' 12345 ' });
    expect(result).toMatchObject({ specialty: 'Cardiology', licenseRegion: 'CA', licenseNumber: '12345', bio: null });
  });

  it('rejects role escalation and invalid application data', () => {
    expect(doctorApplicationSchema.safeParse({ specialty: 'Cardiology', licenseRegion: 'CA', licenseNumber: '12345', role: 'doctor' }).success).toBe(false);
    expect(doctorApplicationSchema.safeParse({ specialty: '', licenseRegion: 'CA', licenseNumber: 'x' }).success).toBe(false);
  });

  it('accepts only explicit approval or rejection decisions, requiring a reason on rejection', () => {
    expect(doctorDecisionSchema.safeParse({ decision: 'approved', role: 'admin' }).success).toBe(false);
    expect(doctorDecisionSchema.safeParse({ decision: 'approved' }).success).toBe(true);
    expect(doctorDecisionSchema.safeParse({ decision: 'rejected' }).success).toBe(false);
    expect(doctorDecisionSchema.safeParse({ decision: 'rejected', reason: 'bad' }).success).toBe(false);
    expect(doctorDecisionSchema.safeParse({ decision: 'rejected', reason: 'License not found in state council database' }).success).toBe(true);
  });

  it('exposes only public profile fields, never licensing or contact data', () => {
    const stored = {
      id: 'profile-1', name: 'Doctor', specialty: 'Cardiology', bio: null,
      userId: 'user-1', email: 'private@example.test', licenseNumber: 'private-license',
      phone: '+919876543210',
      qualifications: 'MBBS, MD', yearsOfExperience: 10,
      consultationFeeInr: 500, clinicName: 'City Clinic', clinicAddress: '123 Main St',
      profilePhotoUrl: null,
    };
    const result = toPublicDoctorProfile(stored);
    expect(result).toEqual({
      id: 'profile-1', name: 'Doctor', specialty: 'Cardiology', bio: null,
      qualifications: 'MBBS, MD', yearsOfExperience: 10,
      consultationFeeInr: 500, clinicName: 'City Clinic', clinicAddress: '123 Main St',
      profilePhotoUrl: null,
      isVerified: true,
    });
    // Must not expose private fields
    expect(result).not.toHaveProperty('phone');
    expect(result).not.toHaveProperty('email');
    expect(result).not.toHaveProperty('licenseNumber');
    expect(result).not.toHaveProperty('userId');
  });

  it('accepts valid extended profile fields', () => {
    const result = doctorApplicationSchema.safeParse({
      specialty: 'Cardiology', licenseRegion: 'CA', licenseNumber: '12345',
      phone: '+919876543210', qualifications: 'MBBS, MD',
      yearsOfExperience: 5, consultationFeeInr: 500,
      clinicName: 'City Clinic', clinicAddress: '123 Main Street',
      profilePhotoUrl: 'https://example.com/photo.jpg',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.phone).toBe('+919876543210');
      expect(result.data.consultationFeeInr).toBe(500);
      expect(result.data.yearsOfExperience).toBe(5);
    }
  });

  it('rejects negative consultation fee', () => {
    expect(doctorApplicationSchema.safeParse({
      specialty: 'Cardiology', licenseRegion: 'CA', licenseNumber: '12345',
      consultationFeeInr: -100,
    }).success).toBe(false);
  });

  it('rejects negative or excessive years of experience', () => {
    expect(doctorApplicationSchema.safeParse({
      specialty: 'Cardiology', licenseRegion: 'CA', licenseNumber: '12345',
      yearsOfExperience: -1,
    }).success).toBe(false);
    expect(doctorApplicationSchema.safeParse({
      specialty: 'Cardiology', licenseRegion: 'CA', licenseNumber: '12345',
      yearsOfExperience: 71,
    }).success).toBe(false);
  });

  it('rejects unknown fields in doctor application schema', () => {
    expect(doctorApplicationSchema.safeParse({
      specialty: 'Cardiology', licenseRegion: 'CA', licenseNumber: '12345',
      hackedField: 'injected',
    }).success).toBe(false);
  });

  describe('doctorProfileUpdateSchema', () => {
    it('accepts valid partial profile updates', () => {
      const res = doctorProfileUpdateSchema.safeParse({
        bio: 'Updated clinical biography.',
        consultationFeeInr: 750,
        clinicName: 'Medrella Speciality Care',
      });
      expect(res.success).toBe(true);
    });

    it('rejects empty update payloads', () => {
      expect(doctorProfileUpdateSchema.safeParse({}).success).toBe(false);
    });

    it('rejects attempts to modify verified licensing fields through update schema', () => {
      expect(doctorProfileUpdateSchema.safeParse({
        licenseNumber: 'HACKED-LICENSE',
        specialty: 'Neurology',
      }).success).toBe(false);
    });
  });
});
