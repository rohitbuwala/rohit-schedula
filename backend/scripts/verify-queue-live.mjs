import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { validateTestTarget } from './verify-assistant-test-db.mjs';

// Only the separate disposable database is permitted. No copied accounts are used.
const target = validateTestTarget(process.env);
const grace = Number(process.env.QUEUE_NO_SHOW_GRACE_MINUTES);
assert.ok(Number.isInteger(grace) && grace > 0 && grace <= 1440, 'Configure the approved positive no-show grace period before verification.');
process.env.DATABASE_URL = target.connectionString;
process.env.EMAIL_DELIVERY_MODE = 'disabled';
const { db, pool } = await import('../dist/db/database.js');
const { sql } = await import('drizzle-orm');
const { StaffAccessService } = await import('../dist/auth/staff-access.service.js');
const { AppointmentQueueService } = await import('../dist/appointments/appointment-queue.service.js');
const { AppointmentQueueLifecycleService } = await import('../dist/appointments/appointment-queue-lifecycle.service.js');
const { AppointmentsService } = await import('../dist/appointments/appointments.service.js');
const { DoctorProfilesService } = await import('../dist/doctors/doctor-profiles.service.js');
const prefix = `queueverify-${randomUUID()}`;
const admin = { id: `${prefix}-admin`, role: 'admin' };
const staff = { id: `${prefix}-staff`, role: 'staff' };
const doctor = { id: `${prefix}-doctor`, name: 'Queue verification doctor', role: 'doctor' };
const patient = { id: `${prefix}-patient`, role: 'patient' };
const userIds = [admin.id, staff.id, doctor.id, patient.id];
const appointmentIds = Array.from({ length: 5 }, () => randomUUID());
const access = new StaffAccessService();
const lifecycle = new AppointmentQueueLifecycleService();
const queue = new AppointmentQueueService(access, lifecycle);
const bookings = new AppointmentsService(new DoctorProfilesService(), undefined, undefined, undefined,
  undefined, undefined, undefined, lifecycle);
const today = new Date().toISOString().slice(0, 10);
const check = label => console.log(`PASS: ${label}`);
async function retry(work) {
  for (let attempt = 0; ; attempt++) {
    try { return await work(); } catch (error) {
      if (error.getStatus?.() !== 409 || attempt >= 3) throw error;
      await new Promise(done => setTimeout(done, 30));
    }
  }
}
try {
  await db.transaction(async tx => {
    for (const actor of [admin, { ...staff, role: 'patient' }, doctor, patient]) {
      await tx.execute(sql`insert into "user" (id,name,email,role) values (${actor.id},'Queue verification',${actor.id + '@example.test'},${actor.role}::user_role)`);
    }
    await tx.execute(sql`insert into doctor_profile (id,user_id,specialty,license_region,license_number,status,reviewed_at,reviewed_by,consultation_fee_inr)
      values (${randomUUID()},${doctor.id},'Verification','TEST',${prefix},'approved',now(),${admin.id},0)`);
    await tx.execute(sql`insert into doctor_availability (id,doctor_id,timezone) values (${randomUUID()},${doctor.id},'UTC')`);
    for (let index = 0; index < appointmentIds.length; index++) {
      const start = index >= 3
        ? new Date(Date.now() - (index === 3 ? grace + 1 : grace - 1) * 60000)
        : new Date(`${today}T09:${String(index * 15).padStart(2, '0')}:00Z`);
      await tx.execute(sql`insert into appointment (id,patient_id,doctor_id,starts_at,ends_at,status)
        values (${appointmentIds[index]},${patient.id},${doctor.id},${start.toISOString()},${new Date(start.getTime() + 900000).toISOString()},'scheduled')`);
    }
  });
  await access.provision(admin, staff.id);
  await access.assign(admin, staff.id, doctor.id);
  assert.equal((await queue.assignments(staff))[0].doctorId, doctor.id);
  check('dedicated staff provisioning and doctor assignment');

  const duplicate = await Promise.all(Array.from({ length: 3 }, () => retry(() => queue.checkIn(staff, appointmentIds[0]))));
  assert.equal(new Set(duplicate.map(row => row.tokenNumber)).size, 1);
  assert.equal(new Set(duplicate.map(row => row.checkedInAt.toISOString())).size, 1);
  const other = await Promise.all([1, 2].map(index => retry(() => queue.checkIn(staff, appointmentIds[index]))));
  assert.equal(new Set([duplicate[0], ...other].map(row => row.tokenNumber)).size, 3);
  const read = () => queue.read(doctor, { doctorId: doctor.id, date: today, limit: 50 });
  let view = await read();
  assert.equal(view.waitingCount, 3);
  assert.deepEqual(view.waiting.map(row => row.appointmentId), appointmentIds.slice(0, 3));
  assert.deepEqual(view.waiting.map(row => row.position), [1, 2, 3]);
  check('real PostgreSQL duplicate and distinct concurrent check-ins, token uniqueness and ordering');
  const own = await queue.ownAttendance(patient, appointmentIds.slice(0, 3));
  assert.equal(own.appointments.length, 3);
  await assert.rejects(queue.ownAttendance({ ...patient, id: staff.id }, [appointmentIds[0]]), error => error.getStatus?.() === 404);
  check('patient own attendance and cross-account denial');

  const input = { serviceDate: today, expectedQueueVersion: view.version };
  const starts = await Promise.allSettled([queue.next(doctor, doctor.id, input), queue.next(doctor, doctor.id, input)]);
  assert.equal(starts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(starts.filter(result => result.status === 'rejected' && result.reason.getStatus?.() === 409).length, 1);
  view = await read(); assert.equal(view.current.appointmentId, appointmentIds[0]);
  await bookings.complete(appointmentIds[0], doctor);
  view = await read(); assert.equal(view.current, null); assert.equal(view.waitingCount, 2);
  assert.equal(view.closed.find(row => row.appointmentId === appointmentIds[0]).status, 'completed');
  await bookings.cancel(appointmentIds[1], doctor);
  view = await read(); assert.equal(view.waitingCount, 1); assert.equal(view.waiting[0].position, 1);
  assert.equal(view.waiting[0].tokenNumber, other[1].tokenNumber);
  check('concurrent start-next, atomic completion and cancellation/position updates without renumbering');

  await access.revoke(admin, staff.id, doctor.id);
  await assert.rejects(queue.read(staff, { doctorId: doctor.id, date: today, limit: 50 }), error => [403, 404].includes(error.getStatus?.()));
  await assert.rejects(queue.checkIn(staff, appointmentIds[2]), error => [403, 404].includes(error.getStatus?.()));
  await access.assign(admin, staff.id, doctor.id);
  delete process.env.QUEUE_NO_SHOW_GRACE_MINUTES;
  await assert.rejects(queue.noShow(staff, appointmentIds[3], {}), error => error.getStatus?.() === 503);
  check('revoked staff cannot read or repeat check-in; missing no-show configuration fails closed');
  process.env.QUEUE_NO_SHOW_GRACE_MINUTES = String(grace);
  await assert.rejects(queue.noShow(staff, appointmentIds[4], {}), error => error.getStatus?.() === 409);
  const absent = await queue.noShow(staff, appointmentIds[3], {});
  assert.equal(absent.status, 'no_show'); assert.equal(absent.tokenNumber, null);
  const repeated = await queue.noShow(staff, appointmentIds[3], {});
  assert.equal(repeated.version, absent.version);
  const untouched = await pool.query('select status from appointment where id=$1', [appointmentIds[3]]);
  assert.equal(untouched.rows[0].status, 'scheduled');
  check(`no-show denied before ${grace} minutes; allowed afterward without token, cancellation or duplicate attendance`);
  const counters = await pool.query('select next_token_number from doctor_daily_queue where doctor_id=$1', [doctor.id]);
  assert.equal(counters.rows[0].next_token_number, 4);
  console.log(`Database-backed queue workflow verified on ${target.host}; no external payments/email or real accounts used.`);
} catch (error) {
  console.error(JSON.stringify({ verificationFailed: true, type: error.constructor?.name,
    status: error.getStatus?.(), code: error.code ?? error.cause?.code ?? null,
    message: error.name === 'AssertionError' ? error.message : 'Sensitive database details omitted.' }));
  process.exitCode = 1;
} finally {
  // Exact fixture identifiers only; dependency order preserves all copied data.
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('delete from appointment_history where appointment_id=any($1::text[])', [appointmentIds]);
      await client.query('delete from appointment_attendance where appointment_id=any($1::text[])', [appointmentIds]);
      await client.query('delete from doctor_daily_queue where doctor_id=$1', [doctor.id]);
      await client.query('delete from appointment where id=any($1::text[])', [appointmentIds]);
      await client.query('delete from staff_doctor_assignment where staff_id=$1', [staff.id]);
      await client.query('delete from doctor_availability where doctor_id=$1', [doctor.id]);
      await client.query('delete from doctor_profile where user_id=$1', [doctor.id]);
      await client.query('delete from "user" where id=any($1::text[])', [userIds]);
      await client.query('COMMIT');
      console.log('Dedicated verification records removed.');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  } catch { console.error(`Fixture cleanup needs review for prefix ${prefix}; copied data was not deleted.`); process.exitCode = 1; }
  await pool.end();
}
