import 'dotenv/config';
import { Pool } from '@neondatabase/serverless';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000 });
try {
  const { rows } = await pool.query(`SELECT
    to_regclass('public.appointment_idempotency') IS NOT NULL AS booking_retry_table,
    to_regclass('public.appointment_idempotency_patient_key_unique') IS NOT NULL AS booking_retry_unique_index,
    to_regclass('public.appointment_prescription') IS NOT NULL AS prescription_table`);
  console.log(rows[0]);
  if (!Object.values(rows[0]).every(Boolean)) {
    console.error('Booking schema is incomplete. Apply the pending database migrations.');
    process.exitCode = 1;
  }
} catch (error) {
  console.error('Booking schema check failed.', { code: error.code ?? 'connection_error' });
  process.exitCode = 1;
} finally {
  await pool.end();
}
