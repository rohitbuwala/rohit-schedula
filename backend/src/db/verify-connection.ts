import { verifyDatabaseConnection, pool } from './database.js';

try {
  await verifyDatabaseConnection();
  console.log('Database connection successful.');
} catch {
  console.error('Database connection failed. Check DATABASE_URL and Neon availability.');
  process.exitCode = 1;
} finally {
  await pool.end();
}
