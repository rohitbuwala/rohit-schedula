import 'dotenv/config';
import { z } from 'zod';

export interface AppEnvironment {
  databaseUrl: string;
  betterAuthSecret: string;
  betterAuthUrl: string;
  frontendUrl: string;
  port: number;
}

const databaseUrlSchema = z.url().refine((value) => ['postgres:', 'postgresql:'].includes(new URL(value).protocol));
const webUrlSchema = z
  .url()
  .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol));

const environmentSchema = z.object({
  DATABASE_URL: databaseUrlSchema,
  BETTER_AUTH_URL: webUrlSchema,
  FRONTEND_URL: webUrlSchema,
  BETTER_AUTH_SECRET: z.string().min(32),
  PORT: z.preprocess((value) => value ?? '5000', z.coerce.number().int().min(1).max(65535)),
});

function parseEnvironment(input: unknown): z.infer<typeof environmentSchema> {
  const result = environmentSchema.safeParse(input);
  if (!result.success) {
    const invalidName = String(result.error.issues[0]?.path[0] ?? 'configuration');
    throw new Error(`Invalid environment variable: ${invalidName}`);
  }
  return result.data;
}

export function loadDatabaseUrl(): string {
  const result = databaseUrlSchema.safeParse(process.env.DATABASE_URL);
  if (!result.success) throw new Error('Invalid environment variable: DATABASE_URL');
  return result.data;
}

export function loadEnv(): AppEnvironment {
  const env = parseEnvironment(process.env);
  return {
    databaseUrl: env.DATABASE_URL,
    betterAuthSecret: env.BETTER_AUTH_SECRET,
    betterAuthUrl: env.BETTER_AUTH_URL,
    frontendUrl: env.FRONTEND_URL,
    port: env.PORT,
  };
}
