import type { UserRole } from '../auth/authenticated-user.js';

export interface AppointmentParticipants {
  patientId: string;
  doctorId: string;
}

export function canAccessAppointment(role: UserRole, userId: string, appointment: AppointmentParticipants): boolean {
  if (role === 'patient') return appointment.patientId === userId;
  if (role === 'doctor') return appointment.doctorId === userId;
  return false;
}
