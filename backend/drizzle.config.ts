import { defineConfig } from 'drizzle-kit';
import { loadDatabaseUrl } from './src/config/env.js';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: loadDatabaseUrl(),
  },
});
