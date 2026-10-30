import { ConflictException } from '@nestjs/common';

export function overlaps(startA: Date, endA: Date, startB: Date, endB: Date): boolean {
  return startA < endB && startB < endA;
}

export function isExclusionViolation(error: unknown): boolean {
  let current: unknown = error;
  while (current && typeof current === 'object') {
    if ('code' in current && current.code === '23P01') return true;
    current = 'cause' in current ? current.cause : null;
  }
  return false;
}

export function appointmentWriteError(error: unknown): ConflictException | null {
  return isExclusionViolation(error)
    ? new ConflictException('The doctor is already booked for that time.')
    : null;
}

export async function createWithConflictHandling<T>(insert: () => Promise<T>): Promise<T> {
  try {
    return await insert();
  } catch (error) {
    const conflict = appointmentWriteError(error);
    if (conflict) throw conflict;
    throw error;
  }
}
