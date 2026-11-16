import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { Logger } from '@nestjs/common';
import { betterAuth, type BetterAuthOptions } from 'better-auth/minimal';
import { loadEnv } from '../config/env.js';
import { db } from '../db/database.js';
import { schema } from '../db/schema.js';

type AuthDatabase = NonNullable<BetterAuthOptions['database']>;
const logger = new Logger('BetterAuth');

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
    logger: {
      // Better Auth can log raw adapter exceptions, including session query parameters.
      log(level) {
        if (level === 'error') logger.error('Authentication operation failed.');
        if (level === 'warn') logger.warn('Authentication warning.');
      },
    },
    emailAndPassword: { enabled: true },
    user: {
      additionalFields: {
        role: { type: ['patient', 'doctor', 'admin'], required: false, defaultValue: 'patient', input: false },
      },
    },
  });
}

export const auth = createAuth(drizzleAdapter(db, { provider: 'pg', schema }));
