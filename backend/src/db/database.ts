import { Logger } from '@nestjs/common';
import { Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { loadDatabaseUrl } from '../config/env.js';
import { schema } from './schema.js';
import { classifyDatabaseFailure } from './database-failure.js';

const logger = new Logger('DatabasePool');
export const pool = new Pool({
  connectionString: loadDatabaseUrl(),
  connectionTimeoutMillis: 10_000,
});
pool.on('error', (error: unknown) => {
  logger.error(`Idle database client disconnected. Database diagnostic: ${classifyDatabaseFailure(error).diagnostic}`);
});
export const db = drizzle({ client: pool, schema });

export async function verifyDatabaseConnection(): Promise<void> {
  await pool.query('select 1');
}
