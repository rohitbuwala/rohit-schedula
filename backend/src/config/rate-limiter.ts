import type { Request, Response, NextFunction, RequestHandler } from 'express';

export type RateLimitTier = 'auth' | 'mutation' | 'general' | 'exempt';

export interface RateLimitConfig {
  windowMs: number;
  limits: Record<Exclude<RateLimitTier, 'exempt'>, number>;
  maxEntries?: number;
  now?: () => number;
}

export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  windowMs: 60_000,
  limits: {
    auth: 20,
    mutation: 30,
    general: 120,
  },
  maxEntries: 10_000,
};

export function classifyRequest(method: string, pathname: string): RateLimitTier {
  const m = method.toUpperCase();
  const p = pathname.toLowerCase();

  // 1. Exempt routes: payment webhooks and system health checks
  if (m === 'POST' && p === '/api/payments/webhook') {
    return 'exempt';
  }
  if (m === 'GET' && (p === '/health' || p === '/api/health')) {
    return 'exempt';
  }

  // Non-API paths (e.g. static assets, root page) are exempt from API rate limiting
  if (!p.startsWith('/api')) {
    return 'exempt';
  }

  // 2. Auth mutations: POST /api/auth/sign-in/* and POST /api/auth/sign-up/*
  if (m === 'POST' && (p.startsWith('/api/auth/sign-in') || p.startsWith('/api/auth/sign-up'))) {
    return 'auth';
  }

  // 3. Booking and payment order mutations
  if (m === 'POST' && (p === '/api/appointments' || p === '/api/payments/orders')) {
    return 'mutation';
  }

  // 4. All other API endpoints fall under the general rate limit
  return 'general';
}

export function getClientIp(req: Request): string {
  if (typeof req.ip === 'string' && req.ip.trim().length > 0) {
    return req.ip.trim();
  }
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim().length > 0) {
    const first = xff.split(',')[0].trim();
    if (first.length > 0) return first;
  }
  if (Array.isArray(xff) && xff.length > 0 && typeof xff[0] === 'string') {
    const first = xff[0].split(',')[0].trim();
    if (first.length > 0) return first;
  }
  if (typeof req.socket?.remoteAddress === 'string' && req.socket.remoteAddress.trim().length > 0) {
    return req.socket.remoteAddress.trim();
  }
  return '127.0.0.1';
}

export class MemoryRateLimitStore {
  private readonly buckets = new Map<string, number[]>();
  private lastCleanup = 0;

  constructor(
    private readonly windowMs: number,
    private readonly maxEntries = 10_000,
  ) {}

  hit(key: string, now: number, limit: number): { allowed: boolean; oldest: number } {
    this.maybeCleanup(now);

    let timestamps = this.buckets.get(key);
    if (!timestamps) {
      if (this.buckets.size >= this.maxEntries) {
        this.forceCleanup(now);
      }
      timestamps = [];
      this.buckets.set(key, timestamps);
    }

    const cutoff = now - this.windowMs;
    while (timestamps.length > 0 && timestamps[0] <= cutoff) {
      timestamps.shift();
    }

    if (timestamps.length >= limit) {
      return { allowed: false, oldest: timestamps[0] ?? now };
    }

    timestamps.push(now);
    return { allowed: true, oldest: timestamps[0] };
  }

  private maybeCleanup(now: number): void {
    if (now - this.lastCleanup > this.windowMs) {
      this.forceCleanup(now);
    }
  }

  private forceCleanup(now: number): void {
    this.lastCleanup = now;
    const cutoff = now - this.windowMs;
    for (const [key, timestamps] of this.buckets.entries()) {
      while (timestamps.length > 0 && timestamps[0] <= cutoff) {
        timestamps.shift();
      }
      if (timestamps.length === 0) {
        this.buckets.delete(key);
      }
    }
  }

  clear(): void {
    this.buckets.clear();
    this.lastCleanup = 0;
  }
}

export function createRateLimiterMiddleware(
  customConfig: Partial<RateLimitConfig> = {},
): RequestHandler {
  const config: RateLimitConfig = {
    ...DEFAULT_RATE_LIMIT_CONFIG,
    ...customConfig,
    limits: {
      ...DEFAULT_RATE_LIMIT_CONFIG.limits,
      ...customConfig.limits,
    },
  };

  const store = new MemoryRateLimitStore(config.windowMs, config.maxEntries);
  const getNow = config.now || Date.now;

  return (req: Request, res: Response, next: NextFunction): void => {
    const rawPath = req.path || (typeof req.url === 'string' ? req.url.split('?')[0] : '');
    const tier = classifyRequest(req.method, rawPath);

    if (tier === 'exempt') {
      return next();
    }

    const limit = config.limits[tier];
    const ip = getClientIp(req);
    const key = `${ip}:${tier}`;
    const now = getNow();

    const { allowed, oldest } = store.hit(key, now, limit);

    if (!allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + config.windowMs - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.status(429).json({
        statusCode: 429,
        message: 'Too many requests. Please try again shortly.',
      });
      return;
    }

    next();
  };
}
