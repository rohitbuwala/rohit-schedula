import { describe, expect, it } from 'vitest';
import {
  detectBookingIntent,
  extractBookingDate,
  extractBookingTime,
  matchDoctorCandidate,
  matchSpecialtyCandidate,
  extractBookingDetails,
  type DoctorProfileCandidate,
} from './booking-intent.js';

describe('Booking Intent Detection', () => {
  it('detects standard booking sentences', () => {
    expect(detectBookingIntent('Book an appointment.')).toBe(true);
    expect(detectBookingIntent('Book tomorrow at 10 AM with Dr Sharma.')).toBe(true);
    expect(detectBookingIntent('I want to see Dr Sharma tomorrow.')).toBe(true);
    expect(detectBookingIntent('Schedule an appointment for next Monday.')).toBe(true);
    expect(detectBookingIntent('Book a cardiologist for tomorrow morning.')).toBe(true);
    expect(detectBookingIntent('I need to consult Dr. Anita')).toBe(true);
    expect(detectBookingIntent('Reserve a slot for Friday')).toBe(true);
  });

  it('rejects mutation and cancellation requests from booking intent', () => {
    expect(detectBookingIntent('Cancel my appointment with Dr. Sharma')).toBe(false);
    expect(detectBookingIntent('I want to reschedule my appointment')).toBe(false);
    expect(detectBookingIntent('How do I pay for my appointment?')).toBe(false);
    expect(detectBookingIntent('Where is my refund?')).toBe(false);
    expect(detectBookingIntent('Book an appointment and cancel my appointment')).toBe(false);
  });

  it('rejects general inquiries without booking intent', () => {
    expect(detectBookingIntent('Show my appointments')).toBe(false);
    expect(detectBookingIntent('List upcoming appointments')).toBe(false);
    expect(detectBookingIntent('What are my prescriptions?')).toBe(false);
    expect(detectBookingIntent('Check payment history')).toBe(false);
  });
});

describe('Natural Language Date Normalization (Asia/Kolkata)', () => {
  // Fix reference date: Saturday, Nov 14, 2026 12:00:00 UTC (17:30 IST)
  const fixedNow = new Date('2026-11-14T12:00:00Z');

  it('extracts explicit ISO dates', () => {
    expect(extractBookingDate('Book on 2026-12-01', fixedNow)).toBe('2026-12-01');
    expect(extractBookingDate('Appointment 2027-01-15', fixedNow)).toBe('2027-01-15');
  });

  it('extracts today and tomorrow in Asia/Kolkata', () => {
    expect(extractBookingDate('Book an appointment for today', fixedNow)).toBe('2026-11-14');
    expect(extractBookingDate('I want to see the doctor tomorrow', fixedNow)).toBe('2026-11-15');
    expect(extractBookingDate('Day after tomorrow please', fixedNow)).toBe('2026-11-16');
  });

  it('extracts upcoming weekdays correctly', () => {
    // Reference date is Saturday, Nov 14, 2026
    // Upcoming Sunday is Nov 15 (+1)
    expect(extractBookingDate('Book for Sunday', fixedNow)).toBe('2026-11-15');
    // Upcoming Monday is Nov 16 (+2)
    expect(extractBookingDate('Schedule an appointment for next Monday', fixedNow)).toBe('2026-11-16');
    // Upcoming Wednesday is Nov 18 (+4)
    expect(extractBookingDate('On Wednesday please', fixedNow)).toBe('2026-11-18');
    // Upcoming Friday is Nov 20 (+6)
    expect(extractBookingDate('This Friday morning', fixedNow)).toBe('2026-11-20');
  });

  it('returns undefined when no date is present', () => {
    expect(extractBookingDate('Book an appointment with Dr. Sharma', fixedNow)).toBeUndefined();
  });
});

describe('Natural Language Time Normalization', () => {
  it('extracts 12-hour AM/PM times and converts to 24-hour HH:mm', () => {
    expect(extractBookingTime('Book tomorrow at 10 AM')).toBe('10:00');
    expect(extractBookingTime('At 10:30 am please')).toBe('10:30');
    expect(extractBookingTime('Around 2 PM')).toBe('14:00');
    expect(extractBookingTime('At 2:45 pm with Dr Sharma')).toBe('14:45');
    expect(extractBookingTime('12 PM noon')).toBe('12:00');
    expect(extractBookingTime('12:30 PM')).toBe('12:30');
    expect(extractBookingTime('12 AM midnight')).toBe('00:00');
    expect(extractBookingTime('12:15 AM')).toBe('00:15');
    expect(extractBookingTime('9am')).toBe('09:00');
  });

  it('extracts 24-hour HH:mm times', () => {
    expect(extractBookingTime('Book at 10:00')).toBe('10:00');
    expect(extractBookingTime('Slot 14:30')).toBe('14:30');
    expect(extractBookingTime('At 09:15')).toBe('09:15');
  });

  it('returns undefined when no explicit time is mentioned', () => {
    expect(extractBookingTime('Book tomorrow morning')).toBeUndefined();
    expect(extractBookingTime('Book an appointment with Dr. Sharma')).toBeUndefined();
  });
});

describe('Doctor & Specialty Candidate Matching', () => {
  const mockProfiles: DoctorProfileCandidate[] = [
    { id: '11111111-1111-1111-1111-111111111111', name: 'Dr. Anita Sharma', specialty: 'Cardiology' },
    { id: '22222222-2222-2222-2222-222222222222', name: 'Dr. Rajesh Patel', specialty: 'Dermatology' },
    { id: '33333333-3333-3333-3333-333333333333', name: 'Dr. Sunil Sharma', specialty: 'Neurology' },
  ];

  it('matches a single unique doctor candidate', () => {
    const singleProfileList = [mockProfiles[0], mockProfiles[1]];
    const result = matchDoctorCandidate('Book with Dr Sharma tomorrow', singleProfileList);
    expect(result.doctorProfileId).toBe('11111111-1111-1111-1111-111111111111');
    expect(result.doctorName).toBe('Dr. Anita Sharma');
    expect(result.ambiguous).toBeUndefined();
  });

  it('flags ambiguous matching when multiple doctors match a surname', () => {
    // Both Dr. Anita Sharma and Dr. Sunil Sharma match "Sharma"
    const result = matchDoctorCandidate('Book with Dr Sharma tomorrow', mockProfiles);
    expect(result.ambiguous).toBe(true);
    expect(result.doctorProfileId).toBeUndefined();
  });

  it('disambiguates by first name', () => {
    const result = matchDoctorCandidate('Book with Dr. Anita tomorrow', mockProfiles);
    expect(result.doctorProfileId).toBe('11111111-1111-1111-1111-111111111111');
    expect(result.doctorName).toBe('Dr. Anita Sharma');
  });

  it('matches specialty synonyms to doctor specialties', () => {
    expect(matchSpecialtyCandidate('I want a cardiologist', mockProfiles)).toBe('Cardiology');
    expect(matchSpecialtyCandidate('Need to see a dermatologist', mockProfiles)).toBe('Dermatology');
    expect(matchSpecialtyCandidate('Neurology consult', mockProfiles)).toBe('Neurology');
  });
});

describe('extractBookingDetails Combined Extraction', () => {
  const mockProfiles: DoctorProfileCandidate[] = [
    { id: '11111111-1111-1111-1111-111111111111', name: 'Dr. Anita Sharma', specialty: 'Cardiology' },
    { id: '22222222-2222-2222-2222-222222222222', name: 'Dr. Rajesh Patel', specialty: 'Dermatology' },
  ];
  const fixedNow = new Date('2026-11-14T12:00:00Z'); // Saturday in India

  it('extracts doctor, date, and time together', () => {
    const details = extractBookingDetails('Book tomorrow at 10 AM with Dr Sharma', mockProfiles, fixedNow);
    expect(details.doctorProfileId).toBe('11111111-1111-1111-1111-111111111111');
    expect(details.doctorName).toBe('Dr. Anita Sharma');
    expect(details.date).toBe('2026-11-15');
    expect(details.time).toBe('10:00');
  });

  it('extracts partial information when only doctor and date are given', () => {
    const details = extractBookingDetails('I want to see Dr Sharma tomorrow', mockProfiles, fixedNow);
    expect(details.doctorProfileId).toBe('11111111-1111-1111-1111-111111111111');
    expect(details.date).toBe('2026-11-15');
    expect(details.time).toBeUndefined();
  });

  it('extracts specialty and date when specialty is requested', () => {
    const details = extractBookingDetails('Book a cardiologist for tomorrow morning', mockProfiles, fixedNow);
    expect(details.specialty).toBe('Cardiology');
    // Only 1 cardiologist in mockProfiles, so it pre-selects Dr. Anita Sharma!
    expect(details.doctorProfileId).toBe('11111111-1111-1111-1111-111111111111');
    expect(details.date).toBe('2026-11-15');
    expect(details.time).toBeUndefined();
  });

  it('handles generic booking request with empty details', () => {
    const details = extractBookingDetails('Book an appointment.', mockProfiles, fixedNow);
    expect(details.doctorProfileId).toBeUndefined();
    expect(details.date).toBeUndefined();
    expect(details.time).toBeUndefined();
  });
});
