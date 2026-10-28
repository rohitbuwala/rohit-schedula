import { patientProfileUpdateSchema } from './patient-profile.schema.js';

describe('patient profile updates', () => {
  it('accepts only approved fields and normalizes the name', () => {
    expect(patientProfileUpdateSchema.parse({ name: '  Alex Patient  ', image: 'https://images.example.test/profile.png' }))
      .toEqual({ name: 'Alex Patient', image: 'https://images.example.test/profile.png' });
  });

  it('rejects identity, role, email, invalid values, and an empty patch', () => {
    expect(patientProfileUpdateSchema.safeParse({ userId: 'other-user', name: 'Alex' }).success).toBe(false);
    expect(patientProfileUpdateSchema.safeParse({ role: 'doctor' }).success).toBe(false);
    expect(patientProfileUpdateSchema.safeParse({ email: 'new@example.test' }).success).toBe(false);
    expect(patientProfileUpdateSchema.safeParse({ image: 'http://images.example.test/a.png' }).success).toBe(false);
    expect(patientProfileUpdateSchema.safeParse({ name: ' ' }).success).toBe(false);
    expect(patientProfileUpdateSchema.safeParse({}).success).toBe(false);
  });
});
