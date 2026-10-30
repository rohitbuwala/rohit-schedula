import { Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { loadDatabaseUrl } from '../config/env.js';
import { schema } from './schema.js';

export const pool = new Pool({ connectionString: loadDatabaseUrl() });
export const db = drizzle({ client: pool, schema });

export async function verifyDatabaseConnection(): Promise<void> {
  await pool.query('select 1');
}
