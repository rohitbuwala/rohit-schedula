import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { betterAuth, type BetterAuthOptions } from 'better-auth/minimal';
import { loadEnv } from '../config/env.js';
import { db } from '../db/database.js';
import { schema } from '../db/schema.js';

type AuthDatabase = NonNullable<BetterAuthOptions['database']>;

export function createAuth(database: AuthDatabase) {
  const env = loadEnv();

  return betterAuth({
    appName: 'Medrella',
    baseURL: env.betterAuthUrl,
    secret: env.betterAuthSecret,
    trustedOrigins: [
      env.frontendUrl,
      'https://rohit-schedula.vercel.app',
      'https://rohit-schedula-*-rohit-buwalas-projects.vercel.app',
    ],
    database,
    emailAndPassword: { enabled: true },
    user: {
      additionalFields: {
        role: { type: ['patient', 'doctor', 'admin'], required: false, defaultValue: 'patient', input: false },
      },
    },
  });
}

export const auth = createAuth(drizzleAdapter(db, { provider: 'pg', schema }));
