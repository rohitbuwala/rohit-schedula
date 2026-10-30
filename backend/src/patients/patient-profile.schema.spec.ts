import { patientProfileUpdateSchema } from './patient-profile.schema.js';

describe('patient profile updates', () => {
  it('accepts only approved fields and normalizes the name', () => {
    expect(patientProfileUpdateSchema.parse({ name: '  Alex Patient  ', image: 'https://images.example.test/profile.png' }))
      .toEqual({ name: 'Alex Patient', image: 'https://images.example.test/profile.png' });
  });

  it('accepts full patient profile details with valid essential fields', () => {
    const fullProfile = {
      name: 'Jane Doe',
      image: 'https://images.example.test/jane.jpg',
      dateOfBirth: '1995-05-15',
      gender: 'female',
      phone: '+919876543210',
      bloodGroup: 'O+',
      address: '123 Health Ave, Mumbai',
      allergies: 'Penicillin, Dust mites',
    };
    const parsed = patientProfileUpdateSchema.parse(fullProfile);
    expect(parsed).toEqual(fullProfile);
  });

  it('accepts partial updates omitting optional fields', () => {
    const partial = {
      phone: '+15551234567',
      bloodGroup: 'AB-',
    };
    const parsed = patientProfileUpdateSchema.parse(partial);
    expect(parsed.phone).toBe('+15551234567');
    expect(parsed.bloodGroup).toBe('AB-');
  });

  it('rejects identity, role, email, invalid values, and an empty patch', () => {
    expect(patientProfileUpdateSchema.safeParse({ userId: 'other-user', name: 'Alex' }).success).toBe(false);
    expect(patientProfileUpdateSchema.safeParse({ role: 'doctor' }).success).toBe(false);
    expect(patientProfileUpdateSchema.safeParse({ email: 'new@example.test' }).success).toBe(false);
    expect(patientProfileUpdateSchema.safeParse({ image: 'http://images.example.test/a.png' }).success).toBe(false);
    expect(patientProfileUpdateSchema.safeParse({ name: ' ' }).success).toBe(false);
    expect(patientProfileUpdateSchema.safeParse({}).success).toBe(false);
  });

  it('rejects invalid date of birth (future date and bad format)', () => {
    expect(patientProfileUpdateSchema.safeParse({ dateOfBirth: '2099-01-01' }).success).toBe(false);
    expect(patientProfileUpdateSchema.safeParse({ dateOfBirth: 'not-a-date' }).success).toBe(false);
  });

  it('rejects invalid phone format and invalid blood group', () => {
    expect(patientProfileUpdateSchema.safeParse({ phone: 'abc' }).success).toBe(false);
    expect(patientProfileUpdateSchema.safeParse({ bloodGroup: 'Z+' }).success).toBe(false);
    expect(patientProfileUpdateSchema.safeParse({ gender: 'unknown' }).success).toBe(false);
  });
});
