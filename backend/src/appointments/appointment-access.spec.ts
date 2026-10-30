import { canAccessAppointment } from './appointment-access.js';

const appointment = { patientId: 'patient-a', doctorId: 'doctor-a' };

describe('appointment ownership', () => {
  it('allows a patient or doctor to access only their appointment', () => {
    expect(canAccessAppointment('patient', 'patient-a', appointment)).toBe(true);
    expect(canAccessAppointment('doctor', 'doctor-a', appointment)).toBe(true);
    expect(canAccessAppointment('patient', 'patient-b', appointment)).toBe(false);
    expect(canAccessAppointment('doctor', 'doctor-b', appointment)).toBe(false);
    expect(canAccessAppointment('admin', 'admin-a', appointment)).toBe(false);
  });
});
