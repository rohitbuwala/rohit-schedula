import assert from "node:assert/strict";
import { it } from "node:test";
import { assignStaffDoctor, findStaffCandidate, provisionStaff, readAssignableDoctors, readStaffAssignments, readStaffPage, revokeStaffDoctor, StaffAccessError } from "../lib/staff-access-api.ts";
const assignment = { id: '00000000-0000-4000-8000-000000000001', staffId: 'staff', doctorId: 'doctor-user', assignedBy: 'admin', createdAt: '2026-11-16T10:00:00Z', revokedAt: null };

it('uses approved doctor user IDs rather than public profile IDs and strips extra fields', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json([{ id: 'profile-id', userId: 'doctor-user', name: 'Test Doctor', specialty: 'Cardiology', status: 'approved', licenseNumber: 'private' }]));
  assert.deepEqual(await readAssignableDoctors(), [{ doctorId: 'doctor-user', name: 'Test Doctor', specialty: 'Cardiology' }]);
});
it('looks up a normalized email through the admin-only API without exposing clinical fields', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => { calls.push({ url, options }); return Response.json({ id: 'candidate', name: 'Candidate', email: 'staff@example.test', role: 'patient', eligible: true, reason: null, medicalRecords: ['private'] }); });
  const candidate = await findStaffCandidate(' STAFF@EXAMPLE.TEST ');
  assert.equal(candidate.email, 'staff@example.test'); assert.equal(candidate.medicalRecords, undefined);
  assert.equal(new URL(calls[0].url, 'http://fixture').searchParams.get('email'), 'staff@example.test');
  assert.equal(calls[0].options.credentials, 'include'); assert.equal(calls[0].options.cache, 'no-store');
});
it('requires the selected scope in assignment responses and verifies revocation', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json([assignment]));
  await assert.rejects(readStaffAssignments('other'), StaffAccessError);
  globalThis.fetch = async () => Response.json(assignment);
  await assert.rejects(revokeStaffDoctor('staff', 'doctor-user'), /verify/);
  globalThis.fetch = async () => Response.json({ ...assignment, revokedAt: '2026-11-16T11:00:00Z' });
  assert.ok((await revokeStaffDoctor('staff', 'doctor-user')).revokedAt);
});
it('sends explicit provisioning confirmation and only the selected doctor identity', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return Response.json(url.endsWith('/assignments') ? assignment : { id: 'staff', name: 'Staff', email: 'staff@example.test', role: 'staff' });
  });
  await provisionStaff('staff'); await assignStaffDoctor('staff', 'doctor-user');
  assert.deepEqual(JSON.parse(calls[0].options.body), { userId: 'staff', confirmed: true });
  assert.deepEqual(JSON.parse(calls[1].options.body), { doctorId: 'doctor-user' });
  for (const call of calls) { assert.equal(call.options.method, 'POST'); assert.equal(call.options.credentials, 'include'); }
});
it('paginates staff accounts with a bounded lookahead', async t => {
  let requested;
  t.mock.method(globalThis, 'fetch', async url => { requested = url; return Response.json(Array.from({ length: 51 }, (_, index) => ({ id: `staff-${index}`, name: 'Staff', email: `staff${index}@example.test`, role: 'staff' }))); });
  const page = await readStaffPage(50);
  assert.equal(page.items.length, 50); assert.equal(page.hasNext, true);
  assert.match(requested, /limit=51/); assert.match(requested, /offset=50/);
});
it('does not expose raw server errors and rejects mismatched account searches', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ message: 'SELECT private credentials' }, { status: 500 }));
  await assert.rejects(readStaffPage(0), error => error instanceof StaffAccessError && !error.message.includes('SELECT'));
  globalThis.fetch = async () => Response.json({ id: 'candidate', name: 'Candidate', email: 'other@example.test', role: 'patient', eligible: true, reason: null });
  await assert.rejects(findStaffCandidate('staff@example.test'), /did not match/);
});
