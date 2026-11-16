export interface ExtractedBookingDetails {
  doctorProfileId?: string;
  doctorName?: string;
  date?: string; // YYYY-MM-DD
  time?: string; // HH:mm in 24-hour format
  specialty?: string;
  isAmbiguousDoctor?: boolean;
}

export interface DoctorProfileCandidate {
  id: string;
  name: string;
  specialty: string;
}

const KOLKATA_TIMEZONE = 'Asia/Kolkata';

const NON_BOOKING_ACTIONS =
  /\b(?:cancel|cancelling|cancellation|refund|refunds|refunded|reschedule|rescheduling|change|changing|modify|modifying|remove|removing|delete|deleting|pay|paying|payment)\b/i;

const BOOKING_INTENT_PATTERNS = [
  /\b(?:book|reserve|schedule)\b/i,
  /\b(?:want|need|like|looking)\s+to\s+(?:see|visit|consult|meet|book|schedule|reserve)\b/i,
  /\b(?:see|consult|visit)\s+(?:dr\.?\s+[a-z]+|a\s+doctor|a\s+specialist|a\s+[a-z]+ologist)\b/i,
  /\b(?:appointment|consultation|slot)\s+(?:with|for)\s+(?:dr\.?\s+[a-z]+|a\s+[a-z]+)\b/i,
  /\bappointment\s+for\s+(?:today|tomorrow|next|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{4}-\d{2}-\d{2})\b/i,
];

const SPECIALTY_SYNONYMS: Record<string, string> = {
  cardiologist: 'cardiology',
  cardiology: 'cardiology',
  dermatologist: 'dermatology',
  dermatology: 'dermatology',
  pediatrician: 'pediatrics',
  pediatrics: 'pediatrics',
  neurologist: 'neurology',
  neurology: 'neurology',
  orthopedic: 'orthopedics',
  orthopedics: 'orthopedics',
  orthopaedist: 'orthopedics',
  physician: 'general medicine',
  'general physician': 'general medicine',
  'general doctor': 'general medicine',
  gynecologist: 'gynecology',
  gynecology: 'gynecology',
  psychiatrist: 'psychiatry',
  psychiatry: 'psychiatry',
  ent: 'ent',
};

const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

export function detectBookingIntent(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) return false;

  // Pure cancellation/refund/payment/reschedule actions must not trigger booking
  if (NON_BOOKING_ACTIONS.test(trimmed)) {
    return false;
  }

  // Inquiry patterns without booking intent (e.g., "show my appointments", "check my prescriptions")
  if (/^(?:show|view|list|check|what\s+are|what\s+is)\b/i.test(trimmed) && !/\b(?:book|schedule|reserve)\b/i.test(trimmed)) {
    return false;
  }

  return BOOKING_INTENT_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function getKolkataDateParts(date: Date): { year: number; month: number; day: number; dayOfWeek: number } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: KOLKATA_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const [year, month, day] = formatter.format(date).split('-').map(Number);

  const dayOfWeekStr = new Intl.DateTimeFormat('en-US', {
    timeZone: KOLKATA_TIMEZONE,
    weekday: 'short',
  }).format(date);

  const shortMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  const dayOfWeek = shortMap[dayOfWeekStr] ?? date.getUTCDay();

  return { year, month, day, dayOfWeek };
}

function formatIsoDate(d: Date): string {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function extractBookingDate(message: string, now = new Date()): string | undefined {
  const text = message.toLowerCase();

  // 1. Explicit ISO Date YYYY-MM-DD
  const isoMatch = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoMatch) {
    const timestamp = Date.parse(`${isoMatch[1]}T00:00:00Z`);
    if (Number.isFinite(timestamp)) {
      return isoMatch[1];
    }
  }

  const { year, month, day, dayOfWeek } = getKolkataDateParts(now);
  const baseDate = new Date(Date.UTC(year, month - 1, day));

  // 2. Day after tomorrow
  if (/\bday\s+after\s+tomorrow\b/i.test(text)) {
    const target = new Date(baseDate);
    target.setUTCDate(target.getUTCDate() + 2);
    return formatIsoDate(target);
  }

  // 3. Tomorrow
  if (/\btomorrow\b/i.test(text)) {
    const target = new Date(baseDate);
    target.setUTCDate(target.getUTCDate() + 1);
    return formatIsoDate(target);
  }

  // 4. Today
  if (/\btoday\b/i.test(text)) {
    return formatIsoDate(baseDate);
  }

  // 5. Weekdays (e.g. "next monday", "this friday", "on wednesday", "monday")
  const weekdayMatch = text.match(/\b(?:(next|this|on)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
  if (weekdayMatch) {
    const prefix = weekdayMatch[1]?.toLowerCase();
    const dayName = weekdayMatch[2]?.toLowerCase();
    const targetDayIndex = WEEKDAY_INDEX[dayName];

    if (targetDayIndex !== undefined) {
      let diff = (targetDayIndex - dayOfWeek + 7) % 7;
      if (diff === 0) {
        // If today is Monday and user says "next Monday" or "Monday", target the next week's Monday (+7)
        diff = 7;
      } else if (prefix === 'next' && diff < 7) {
        // "next <weekday>" usually means the upcoming one
        // diff is already between 1 and 6
      }
      const target = new Date(baseDate);
      target.setUTCDate(target.getUTCDate() + diff);
      return formatIsoDate(target);
    }
  }

  return undefined;
}

export function extractBookingTime(message: string): string | undefined {
  const text = message.toLowerCase();

  // 1. 12-hour time: e.g. "10 AM", "10:30 am", "2 PM", "2:30 pm", "12 pm", "12 am"
  const twelveHourMatch = text.match(/\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(am|pm)\b/i);
  if (twelveHourMatch) {
    let hour = parseInt(twelveHourMatch[1], 10);
    const minute = twelveHourMatch[2] ? parseInt(twelveHourMatch[2], 10) : 0;
    const meridiem = twelveHourMatch[3].toLowerCase();

    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;

    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }

  // 2. 24-hour time: e.g. "10:00", "14:30", "09:15"
  const twentyFourHourMatch = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (twentyFourHourMatch) {
    const hour = parseInt(twentyFourHourMatch[1], 10);
    const minute = parseInt(twentyFourHourMatch[2], 10);
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }

  return undefined;
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/^dr\.?\s+/, '').trim();
}

export function matchDoctorCandidate(
  message: string,
  profiles: DoctorProfileCandidate[],
): { doctorProfileId?: string; doctorName?: string; ambiguous?: boolean } {
  if (!profiles.length) return {};
  const text = message.toLowerCase();

  // Strip prefixes like "Dr." or "Doctor"
  const matches: DoctorProfileCandidate[] = [];

  for (const profile of profiles) {
    const fullName = profile.name.toLowerCase();
    const cleanName = normalizeName(profile.name);
    const nameTokens = cleanName.split(/\s+/).filter((t) => t.length > 2);

    // Check full name match
    if (text.includes(fullName) || text.includes(cleanName)) {
      matches.push(profile);
      continue;
    }

    // Check token match (e.g. "Dr Sharma" matches Dr. Anita Sharma if "sharma" is in message)
    const tokenMatch = nameTokens.some((token) => {
      const regex = new RegExp(`\\b${token}\\b`, 'i');
      return regex.test(text);
    });

    if (tokenMatch) {
      matches.push(profile);
    }
  }

  // Deduplicate by ID
  const uniqueMatches = Array.from(new Map(matches.map((p) => [p.id, p])).values());

  if (uniqueMatches.length === 1) {
    return {
      doctorProfileId: uniqueMatches[0].id,
      doctorName: uniqueMatches[0].name,
    };
  }

  if (uniqueMatches.length > 1) {
    return { ambiguous: true };
  }

  return {};
}

export function matchSpecialtyCandidate(
  message: string,
  profiles: DoctorProfileCandidate[],
): string | undefined {
  const text = message.toLowerCase();

  for (const [trigger, canonical] of Object.entries(SPECIALTY_SYNONYMS)) {
    const regex = new RegExp(`\\b${trigger}\\b`, 'i');
    if (regex.test(text)) {
      // Find matching profile specialty that corresponds to this canonical
      const matchedProfile = profiles.find((p) =>
        p.specialty.toLowerCase().includes(canonical) ||
        p.specialty.toLowerCase().includes(trigger),
      );
      if (matchedProfile) {
        return matchedProfile.specialty;
      }
      // Or return capitalized canonical
      return canonical.charAt(0).toUpperCase() + canonical.slice(1);
    }
  }

  // Also check profile specialties directly
  for (const profile of profiles) {
    const spec = profile.specialty.toLowerCase();
    const regex = new RegExp(`\\b${spec}\\b`, 'i');
    if (regex.test(text)) {
      return profile.specialty;
    }
  }

  return undefined;
}

export function extractBookingDetails(
  message: string,
  profiles: DoctorProfileCandidate[],
  now = new Date(),
): ExtractedBookingDetails {
  const doctorMatch = matchDoctorCandidate(message, profiles);
  const date = extractBookingDate(message, now);
  const time = extractBookingTime(message);
  const specialty = matchSpecialtyCandidate(message, profiles);

  // If a specialty is specified and no specific doctor was matched, check if there's only 1 doctor for that specialty
  let doctorProfileId = doctorMatch.doctorProfileId;
  let doctorName = doctorMatch.doctorName;

  if (!doctorProfileId && specialty && !doctorMatch.ambiguous) {
    const specialtyDoctors = profiles.filter((p) =>
      p.specialty.toLowerCase() === specialty.toLowerCase() ||
      p.specialty.toLowerCase().includes(specialty.toLowerCase()),
    );
    if (specialtyDoctors.length === 1) {
      doctorProfileId = specialtyDoctors[0].id;
      doctorName = specialtyDoctors[0].name;
    }
  }

  return {
    doctorProfileId,
    doctorName,
    date,
    time,
    specialty,
    isAmbiguousDoctor: doctorMatch.ambiguous,
  };
}
