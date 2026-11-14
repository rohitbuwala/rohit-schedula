import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Pool } from '@neondatabase/serverless';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { loadAssistantTestEnvironment, validateTestTarget } from './verify-assistant-test-db.mjs';

const folder = fileURLToPath(new URL('../drizzle/', import.meta.url));
const reminderTags = [
  '0010_appointment_reminders',
  '0011_reminder_payload_snapshot',
  '0012_reminder_retention_index',
];

const schemaCheck = `
  SELECT
    to_regclass('public.appointment_reminder') IS NOT NULL AS reminder_table,
    to_regclass('public.appointment_reminder_retention_idx') IS NOT NULL AS retention_index,
    count(*) FILTER (WHERE table_name = 'appointment' AND column_name = 'reminder_generation')::int AS generation,
    count(*) FILTER (WHERE table_name = 'appointment' AND column_name = 'reminder_generation'
      AND data_type = 'integer' AND is_nullable = 'NO' AND column_default = '0')::int AS valid_generation,
    count(*) FILTER (WHERE table_name = 'appointment_reminder'
      AND column_name IN ('recipient_email', 'recipient_name', 'other_party_name'))::int AS payload_columns,
    count(*) FILTER (WHERE table_name = 'appointment_reminder' AND data_type = 'text' AND is_nullable = 'NO'
      AND column_name IN ('recipient_email', 'recipient_name', 'other_party_name'))::int AS valid_payload_columns
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name IN ('appointment', 'appointment_reminder')
`;

function appliedCount(state) {
  if (!state.reminder_table && state.generation === 0 && !state.retention_index) return 0;
  if (!state.reminder_table || state.valid_generation !== 1) return -1;
  if (state.payload_columns === 0 && !state.retention_index) return 1;
  if (state.valid_payload_columns !== 3) return -1;
  return state.retention_index ? 3 : 2;
}

async function prepare() {
  const target = validateTestTarget(loadAssistantTestEnvironment());
  const { entries } = JSON.parse(readFileSync(new URL('meta/_journal.json', new URL('../drizzle/', import.meta.url))));
  const migrationFiles = readMigrationFiles({ migrationsFolder: folder });
  const migrations = reminderTags.map((tag) => {
    const migration = migrationFiles[entries.findIndex((entry) => entry.tag === tag)];
    if (!migration) throw new Error('Required reminder migration is missing from the local journal.');
    return migration;
  });
  const pool = new Pool({ connectionString: target.connectionString, connectionTimeoutMillis: 10_000 });
  let client;
  let stage = 'connect to the isolated test database';
  let transactionOpen = false;
  let failure;
  const applied = [];
  try {
    client = await pool.connect();
    stage = 'verify database identity';
    const identity = await client.query('SELECT current_database() AS name');
    if (identity.rows[0]?.name !== target.database) throw new Error();
    await client.query('BEGIN');
    transactionOpen = true;
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query('SET LOCAL search_path TO public');
    await client.query('SELECT pg_advisory_xact_lock(731461012)');
    stage = 'inspect the existing reminder schema (partial or inconsistent schema is refused)';
    const state = appliedCount((await client.query(schemaCheck)).rows[0]);
    if (state < 0) throw new Error();

    // Schema-only branches can contain the journal table without its data.
    // Never replay or synthesize baseline migrations. Reject a conflicting ledger.
    stage = 'check the existing Drizzle migration ledger';
    const ledger = await client.query("SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present");
    let recordMigrations = false;
    if (ledger.rows[0].present) {
      const rows = (await client.query('SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows;
      const firstReminder = entries.findIndex((entry) => entry.tag === reminderTags[0]);
      const expected = entries.slice(0, firstReminder + state);
      if (rows.length && (rows.length !== expected.length || rows.some((row, index) =>
        Number(row.created_at) !== expected[index].when))) {
        throw new Error();
      }
      recordMigrations = rows.length > 0;
    }

    for (const [index, migration] of migrations.entries()) {
      if (index < state) continue;
      stage = `apply ${reminderTags[index]}`;
      for (const statement of migration.sql) {
        if (statement.trim()) await client.query(statement);
      }
      if (recordMigrations) {
        await client.query('INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)',
          [migration.hash, migration.folderMillis]);
      }
      applied.push(reminderTags[index]);
    }
    stage = 'verify reminder_generation and the completed reminder schema';
    if (appliedCount((await client.query(schemaCheck)).rows[0]) !== migrations.length) throw new Error();
    await client.query('COMMIT');
    transactionOpen = false;
    console.log(`Verified public.appointment.reminder_generation on ${target.host}/${target.database}.`);
    console.log(applied.length ? `Applied: ${applied.join(', ')}.` : 'Required reminder migrations are already present.');
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? ` [${error.code}]` : '';
    failure = `Assistant test preparation could not ${stage}${code}.`;
  } finally {
    try {
      if (transactionOpen) await client.query('ROLLBACK');
    } catch { failure ??= 'Assistant test migration rollback could not be confirmed.'; }
    client?.release();
    try { await pool.end(); }
    catch { failure ??= 'Could not close the assistant test database connection.'; }
  }
  if (failure) throw new Error(failure);
}

try {
  await prepare();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
