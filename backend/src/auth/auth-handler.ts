import type { Express } from 'express';
import { toNodeHandler } from 'better-auth/node';
import { auth } from './auth.js';

export function registerAuthHandler(server: Express, instance = auth): void {
  server.all('/api/auth/*splat', toNodeHandler(instance));
}
