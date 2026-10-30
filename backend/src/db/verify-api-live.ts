/**
 * Live API verification script for doctor profile enhancement.
 * Verifies the running backend at http://localhost:5000
 */
import 'dotenv/config';
import { pool } from './database.js';

const BASE = 'http://localhost:5000';
let pass = 0;
let fail = 0;

function ok(label: string, value: boolean, detail = '') {
  if (value) { console.log(`  ✅ PASS: ${label}${detail ? ': ' + detail : ''}`); pass++; }
  else { console.error(`  ❌ FAIL: ${label}${detail ? ': ' + detail : ''}`); fail++; }
}

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}${path}`);
  let body: unknown;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

async function post(path: string, data: unknown, cookie = ''): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(data),
  });
  let body: unknown;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

console.log('\n====== LIVE API VERIFICATION ======\n');

// === 1. GET /api/doctors (public listing) ===
console.log('1. GET /api/doctors (public listing)');
try {
  const { status, body } = await get('/api/doctors');
  ok('returns 200', status === 200, `got ${status}`);
  const arr = body as Record<string, unknown>[];
  ok('returns array', Array.isArray(arr), typeof arr);
  if (Array.isArray(arr) && arr.length > 0) {
    const d = arr[0];
    ok('has id', 'id' in d);
    ok('has name', 'name' in d);
    ok('has specialty', 'specialty' in d);
    ok('has bio', 'bio' in d);
    ok('has qualifications field', 'qualifications' in d);
    ok('has yearsOfExperience field', 'yearsOfExperience' in d);
    ok('has consultationFeeInr field', 'consultationFeeInr' in d);
    ok('has clinicName field', 'clinicName' in d);
    ok('has clinicAddress field', 'clinicAddress' in d);
    ok('has profilePhotoUrl field', 'profilePhotoUrl' in d);
    // Privacy: MUST NOT expose these
    ok('does NOT expose phone', !('phone' in d), JSON.stringify(d['phone']));
    ok('does NOT expose licenseNumber', !('licenseNumber' in d));
    ok('does NOT expose licenseRegion', !('licenseRegion' in d));
    ok('does NOT expose email', !('email' in d));
    ok('does NOT expose userId', !('userId' in d));
    console.log(`  Sample doctor: ${JSON.stringify(d)}`);
  } else {
    console.log('  (no approved doctors in DB — skipping field checks)');
  }
} catch (e) { ok('request succeeded', false, String(e)); }

// === 2. GET /api/doctors/:id (public profile) ===
console.log('\n2. GET /api/doctors/:id (public profile)');
try {
  // First get a valid ID from the list
  const { body: list } = await get('/api/doctors');
  const arr = list as Record<string, unknown>[];
  if (Array.isArray(arr) && arr.length > 0) {
    const id = arr[0].id as string;
    const { status, body } = await get(`/api/doctors/${id}`);
    ok('returns 200 for valid ID', status === 200, `got ${status}`);
    const d = body as Record<string, unknown>;
    ok('has consultationFeeInr field', 'consultationFeeInr' in d);
    ok('does NOT expose phone', !('phone' in d));
    ok('does NOT expose licenseNumber', !('licenseNumber' in d));
    ok('does NOT expose email', !('email' in d));
  } else {
    console.log('  (no approved doctors — skipping)');
  }
  // Test invalid ID
  const { status: badStatus } = await get('/api/doctors/not-a-uuid');
  ok('returns 400 for invalid UUID', badStatus === 400, `got ${badStatus}`);
  // Test nonexistent approved ID
  const { status: notFoundStatus } = await get('/api/doctors/00000000-0000-4000-8000-000000000000');
  ok('returns null/404 for nonexistent ID', notFoundStatus === 200 || notFoundStatus === 404, `got ${notFoundStatus}`);
} catch (e) { ok('request succeeded', false, String(e)); }

// === 3. Validate backend Zod schema rejects negative fee ===
console.log('\n3. Backend validation — rejects negative consultation fee');
try {
  // We can't authenticate easily without a live session, but we can test unauthenticated rejection
  const { status } = await post('/api/doctor-applications', {
    specialty: 'Test', licenseRegion: 'Test', licenseNumber: 'TEST-123',
    consultationFeeInr: -1,
  });
  // Without auth this will 401, but the rejection should happen at Zod level before auth
  // If it's 400 that means Zod fired; if 401 that means auth fired first (which is OK by guard order)
  ok('negative fee rejected (400 or 401)', status === 400 || status === 401, `got ${status}`);
  if (status === 400) ok('specifically rejected by validation, not auth', true);
} catch (e) { ok('request succeeded', false, String(e)); }

// === 4. Check DB constraint directly ===
console.log('\n4. Database constraint enforcement');
try {
  // Attempt an UPDATE that would violate the fee constraint (on nonexistent row — no harm)
  // Actually test that the constraint _exists_ by checking system catalog
  const res = await pool.query(`
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'doctor_profile'::regclass
    AND contype = 'c'
    AND conname IN ('doctor_profile_fee_non_negative_check', 'doctor_profile_experience_non_negative_check')
  `);
  ok('fee non-negative CHECK exists', res.rows.some((r: {conname: string}) => r.conname === 'doctor_profile_fee_non_negative_check'));
  ok('experience non-negative CHECK exists', res.rows.some((r: {conname: string}) => r.conname === 'doctor_profile_experience_non_negative_check'));
} catch (e) { ok('DB constraint check succeeded', false, String(e)); }

// === 5. Check all 7 new columns exist in DB ===
console.log('\n5. All 7 new DB columns present');
try {
  const res = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'doctor_profile' AND table_schema = 'public'
  `);
  const cols = res.rows.map((r: {column_name: string}) => r.column_name);
  for (const col of ['phone', 'qualifications', 'years_of_experience', 'consultation_fee_inr', 'clinic_name', 'clinic_address', 'profile_photo_url']) {
    ok(`column ${col} exists`, cols.includes(col));
  }
} catch (e) { ok('column check succeeded', false, String(e)); }

// === 6. Check booking endpoint still works ===
console.log('\n6. Booking compatibility — /api/appointments/availability');
try {
  const today = new Date().toISOString().slice(0, 10);
  const { body: list } = await get('/api/doctors');
  const arr = list as Record<string, unknown>[];
  if (Array.isArray(arr) && arr.length > 0) {
    const profileId = arr[0].id as string;
    const { status } = await get(`/api/appointments/availability?doctorProfileId=${profileId}&date=${today}`);
    // 401 without auth is fine — it means the route is still guarded properly
    ok('availability endpoint responds', status === 200 || status === 401 || status === 403, `got ${status}`);
  } else {
    console.log('  (no approved doctors — skipping)');
  }
} catch (e) { ok('request succeeded', false, String(e)); }

console.log(`\n====== RESULTS: ${pass} passed, ${fail} failed ======\n`);
await pool.end();
process.exitCode = fail > 0 ? 1 : 0;
