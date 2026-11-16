import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Pool } from '@neondatabase/serverless';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { loadAssistantTestEnvironment, validateTestTarget } from './verify-assistant-test-db.mjs';

const folder = fileURLToPath(new URL('../drizzle/', import.meta.url));
const idempotencyTags = [
  '0016_appointment_prescriptions',
  '0017_appointment_idempotency',
];

const baselineCheck = `
  SELECT
    to_regclass('public.user') IS NOT NULL AS user_table,
    to_regclass('public.appointment') IS NOT NULL AS appointment_table
`;

const schemaCheck = `
  SELECT
    to_regclass('public.appointment_prescription') IS NOT NULL AS prescription_table,
    to_regclass('public.appointment_idempotency') IS NOT NULL AS idempotency_table,
    to_regclass('public.appointment_idempotency_patient_key_unique') IS NOT NULL AS idempotency_unique_idx,
    count(*) FILTER (WHERE table_name = 'appointment_idempotency'
      AND column_name IN ('patient_id', 'key', 'payload_hash', 'appointment_id'))::int AS idempotency_columns,
    count(*) FILTER (WHERE table_name = 'appointment_idempotency'
      AND data_type = 'text' AND is_nullable = 'NO'
      AND column_name IN ('patient_id', 'key', 'payload_hash', 'appointment_id'))::int AS valid_idempotency_columns
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name IN ('appointment_idempotency')
`;

function assessSchemaState(state) {
  // 0: Neither 0016 nor 0017 is present
  if (!state.prescription_table && !state.idempotency_table && !state.idempotency_unique_idx && state.idempotency_columns === 0) {
    return 0;
  }
  // 1: 0016 is present, 0017 is absent
  if (state.prescription_table && !state.idempotency_table && !state.idempotency_unique_idx && state.idempotency_columns === 0) {
    return 1;
  }
  // 2: Both 0016 and 0017 are fully and validly present
  if (state.prescription_table && state.idempotency_table && state.idempotency_unique_idx && state.valid_idempotency_columns === 4) {
    return 2;
  }
  // -1: Inconsistent or partial schema
  return -1;
}

export async function prepareIdempotencyTestDb() {
  // 1. Validate environment and strictly assert endpoint isolation from DATABASE_URL
  const target = validateTestTarget(loadAssistantTestEnvironment());

  // 2. Load migration files and canonical journal sequence
  const { entries } = JSON.parse(readFileSync(new URL('meta/_journal.json', new URL('../drizzle/', import.meta.url))));
  const migrationFiles = readMigrationFiles({ migrationsFolder: folder });

  const migrations = idempotencyTags.map((tag) => {
    const entryIndex = entries.findIndex((entry) => entry.tag === tag);
    if (entryIndex === -1) throw new Error(`Required migration ${tag} is missing from the local journal.`);
    const migration = migrationFiles[entryIndex];
    if (!migration) throw new Error(`Required migration file for ${tag} could not be read.`);
    return { ...migration, tag, entryIndex };
  });

  // 3. Connect EXCLUSIVELY to ASSISTANT_TEST_DATABASE_URL
  const pool = new Pool({
    connectionString: target.connectionString,
    connectionTimeoutMillis: 10_000,
  });

  let client;
  let stage = 'connect to the isolated test database';
  let transactionOpen = false;
  let failure;
  const applied = [];

  try {
    client = await pool.connect();

    stage = 'verify database identity';
    const identity = await client.query('SELECT current_database() AS name');
    if (identity.rows[0]?.name !== target.database) {
      throw new Error(`Database identity mismatch: expected ${target.database}`);
    }

    stage = 'begin migration transaction';
    await client.query('BEGIN');
    transactionOpen = true;

    // Safety timeouts and transactional advisory lock
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query('SET LOCAL search_path TO public');
    await client.query('SELECT pg_advisory_xact_lock(731461014)');

    stage = 'verify baseline prerequisites';
    const baseline = (await client.query(baselineCheck)).rows[0];
    if (!baseline.user_table || !baseline.appointment_table) {
      throw new Error('Baseline tables (public.user, public.appointment) are missing from test database.');
    }

    stage = 'inspect existing idempotency schema state';
    const state = assessSchemaState((await client.query(schemaCheck)).rows[0]);
    if (state < 0) {
      throw new Error('Existing database schema is in an inconsistent or partial state.');
    }

    stage = 'verify Drizzle migration ledger integrity';
    const ledger = await client.query("SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present");
    if (!ledger.rows[0]?.present) {
      throw new Error('Drizzle migrations ledger table is missing from the test database.');
    }

    const ledgerRows = (await client.query('SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at ASC')).rows;

    // The test branch must have baseline migrations 0000..0015 recorded
    const firstTargetIndex = entries.findIndex((entry) => entry.tag === idempotencyTags[0]);
    const expectedPrefix = entries.slice(0, firstTargetIndex + state);

    if (ledgerRows.length < firstTargetIndex) {
      throw new Error(`Ledger has ${ledgerRows.length} entries, expected at least ${firstTargetIndex} baseline entries.`);
    }

    // Verify that every required journal entry in expectedPrefix is recorded in the ledger
    const ledgerPrefixMismatch = expectedPrefix.some((entry) => {
      return !ledgerRows.some((row) => Number(row.created_at) === entry.when);
    });

    if (ledgerPrefixMismatch) {
      throw new Error('Existing migration ledger does not match the canonical journal baseline.');
    }

    // Apply pending migrations sequentially
    for (const [index, migration] of migrations.entries()) {
      if (index < state) {
        // Already present in schema; confirm ledger has it
        const alreadyRecorded = ledgerRows.some((r) => Number(r.created_at) === migration.folderMillis);
        if (!alreadyRecorded) {
          throw new Error(`Schema object exists for ${migration.tag} but ledger entry is missing.`);
        }
        continue;
      }

      stage = `apply ${migration.tag}`;
      for (const statement of migration.sql) {
        if (statement.trim()) {
          await client.query(statement);
        }
      }

      stage = `record ${migration.tag} in Drizzle ledger`;
      await client.query(
        'INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)',
        [migration.hash, migration.folderMillis]
      );

      applied.push(migration.tag);
    }

    stage = 'verify completed idempotency schema';
    const postState = assessSchemaState((await client.query(schemaCheck)).rows[0]);
    if (postState !== migrations.length) {
      throw new Error('Post-migration schema verification failed.');
    }

    await client.query('COMMIT');
    transactionOpen = false;

    console.log(`Verified idempotency schema on ${target.host}/${target.database}.`);
    console.log(applied.length ? `Applied: ${applied.join(', ')}.` : 'Migrations 0016 and 0017 are already present.');
    return { applied, target: { host: target.host, database: target.database } };
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? ` [${error.code}]` : '';
    failure = `Idempotency test DB preparation failed during '${stage}'${code}: ${error?.message ?? error}`;
  } finally {
    try {
      if (transactionOpen) await client.query('ROLLBACK');
    } catch {
      failure ??= 'Migration transaction rollback could not be confirmed.';
    }
    if (client) client.release();
    try {
      await pool.end();
    } catch {
      failure ??= 'Could not close the test database connection pool cleanly.';
    }
  }

  if (failure) throw new Error(failure);
}

async function main() {
  try {
    await prepareIdempotencyTestDb();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
