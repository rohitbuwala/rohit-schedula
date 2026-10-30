import { doctorApplicationSchema, doctorDecisionSchema, toPublicDoctorProfile } from './doctor-profile.schema.js';

describe('doctor application validation', () => {
  it('accepts minimum license details and normalizes text', () => {
    const result = doctorApplicationSchema.parse({ specialty: '  Cardiology ', licenseRegion: ' CA ', licenseNumber: ' 12345 ' });
    expect(result).toMatchObject({ specialty: 'Cardiology', licenseRegion: 'CA', licenseNumber: '12345', bio: null });
  });

  it('rejects role escalation and invalid application data', () => {
    expect(doctorApplicationSchema.safeParse({ specialty: 'Cardiology', licenseRegion: 'CA', licenseNumber: '12345', role: 'doctor' }).success).toBe(false);
    expect(doctorApplicationSchema.safeParse({ specialty: '', licenseRegion: 'CA', licenseNumber: 'x' }).success).toBe(false);
  });

  it('accepts only explicit approval or rejection decisions', () => {
    expect(doctorDecisionSchema.safeParse({ decision: 'approved', role: 'admin' }).success).toBe(false);
    expect(doctorDecisionSchema.safeParse({ decision: 'approved' }).success).toBe(true);
  });

  it('exposes only public profile fields, never licensing or contact data', () => {
    const stored = { id: 'profile-1', name: 'Doctor', specialty: 'Cardiology', bio: null, userId: 'user-1', email: 'private@example.test', licenseNumber: 'private-license' };
    expect(toPublicDoctorProfile(stored)).toEqual({ id: 'profile-1', name: 'Doctor', specialty: 'Cardiology', bio: null });
  });
});
