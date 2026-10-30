import 'dotenv/config';
import { pool } from './database.js';

try {
  // 1. Find the drizzle migrations table structure
  const tables = await pool.query(`
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_name LIKE '%drizzle%' OR table_name LIKE '%migration%'
    ORDER BY table_schema, table_name
  `);
  console.log('=== DRIZZLE/MIGRATION TABLES ===');
  for (const r of tables.rows) console.log(`  ${r.table_schema}.${r.table_name}`);

  // 2. Try the common drizzle migrations table
  try {
    const mig = await pool.query(`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`);
    console.log('\n=== drizzle.__drizzle_migrations ===');
    for (const r of mig.rows) console.log(' ', JSON.stringify(r));
  } catch (e) {
    console.log('  drizzle.__drizzle_migrations not found:', e instanceof Error ? e.message : e);
  }

  // 3. Check doctor_profile columns in actual DB
  console.log('\n=== doctor_profile COLUMNS IN DB ===');
  const cols = await pool.query(`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_name = 'doctor_profile' AND table_schema = 'public'
    ORDER BY ordinal_position
  `);
  for (const c of cols.rows) {
    console.log(`  ${c.column_name} | ${c.data_type} | nullable=${c.is_nullable}`);
  }

  // 4. Check CHECK constraints
  console.log('\n=== doctor_profile CHECK CONSTRAINTS ===');
  const constraints = await pool.query(`
    SELECT conname, pg_get_constraintdef(oid) AS def
    FROM pg_constraint
    WHERE conrelid = 'doctor_profile'::regclass AND contype = 'c'
    ORDER BY conname
  `);
  for (const c of constraints.rows) console.log(`  ${c.conname}: ${c.def}`);

  // 5. Row count
  const cnt = await pool.query(`SELECT COUNT(*) FROM doctor_profile`);
  console.log(`\n=== doctor_profile ROW COUNT: ${cnt.rows[0].count} ===`);

} catch (err) {
  console.error('FATAL:', err instanceof Error ? err.message : err);
} finally {
  await pool.end();
}
