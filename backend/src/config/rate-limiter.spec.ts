import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import {
  classifyRequest,
  getClientIp,
  createRateLimiterMiddleware,
} from './rate-limiter.js';

interface MockResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  setHeader: (name: string, value: string) => MockResponse;
  status: (code: number) => MockResponse;
  json: (data: unknown) => MockResponse;
}

function createMockResponse(): MockResponse {
  const res: MockResponse = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(data: unknown) {
      this.body = data;
      return this;
    },
  };
  return res;
}

function createMockRequest(
  method: string,
  path: string,
  ip = '127.0.0.1',
  headers: Record<string, string> = {},
): Request {
  return {
    method,
    path,
    url: path,
    ip,
    headers,
    socket: { remoteAddress: ip },
  } as unknown as Request;
}

describe('Rate Limiter Request Classification', () => {
  it('classifies auth mutation endpoints as auth tier', () => {
    expect(classifyRequest('POST', '/api/auth/sign-in/email')).toBe('auth');
    expect(classifyRequest('POST', '/api/auth/sign-up/email')).toBe('auth');
  });

  it('classifies booking and payment mutation endpoints as mutation tier', () => {
    expect(classifyRequest('POST', '/api/appointments')).toBe('mutation');
    expect(classifyRequest('POST', '/api/payments/orders')).toBe('mutation');
  });

  it('classifies other API endpoints as general tier', () => {
    expect(classifyRequest('GET', '/api/auth/get-session')).toBe('general');
    expect(classifyRequest('POST', '/api/auth/sign-out')).toBe('general');
    expect(classifyRequest('GET', '/api/appointments/availability')).toBe('general');
    expect(classifyRequest('GET', '/api/appointments/me')).toBe('general');
    expect(classifyRequest('PATCH', '/api/appointments/some-uuid/cancel')).toBe('general');
    expect(classifyRequest('POST', '/api/payments/verify')).toBe('general');
    expect(classifyRequest('POST', '/api/assistant/chat')).toBe('general');
  });

  it('classifies webhooks and health endpoints as exempt', () => {
    expect(classifyRequest('POST', '/api/payments/webhook')).toBe('exempt');
    expect(classifyRequest('GET', '/health')).toBe('exempt');
    expect(classifyRequest('GET', '/api/health')).toBe('exempt');
    expect(classifyRequest('GET', '/favicon.ico')).toBe('exempt');
  });
});

describe('Rate Limiter Client IP Resolution', () => {
  it('uses req.ip when available', () => {
    const req = { ip: '192.168.1.5' } as Request;
    expect(getClientIp(req)).toBe('192.168.1.5');
  });

  it('extracts first IP from x-forwarded-for header', () => {
    const req = {
      ip: undefined,
      headers: { 'x-forwarded-for': '203.0.113.195, 70.41.3.18, 150.172.238.178' },
    } as unknown as Request;
    expect(getClientIp(req)).toBe('203.0.113.195');
  });

  it('falls back to socket.remoteAddress when req.ip and xff are absent', () => {
    const req = {
      ip: undefined,
      headers: {},
      socket: { remoteAddress: '10.0.0.1' },
    } as unknown as Request;
    expect(getClientIp(req)).toBe('10.0.0.1');
  });

  it('falls back gracefully to 127.0.0.1 when IP is missing or empty', () => {
    const req = {
      ip: '',
      headers: {},
      socket: {},
    } as unknown as Request;
    expect(getClientIp(req)).toBe('127.0.0.1');
  });
});

describe('Rate Limiter Middleware Execution', () => {
  it('allows requests below threshold and calls next() without modifying response', () => {
    const middleware = createRateLimiterMiddleware();
    const req = createMockRequest('POST', '/api/auth/sign-in/email');
    const res = createMockResponse();
    const next = vi.fn();

    middleware(req, res as unknown as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBeNull();
  });

  it('enforces auth mutation limit (20 req / 60s) and returns 429 with Retry-After on 21st request', () => {
    let fakeTime = 1_000_000;
    const middleware = createRateLimiterMiddleware({
      now: () => fakeTime,
    });
    const ip = '10.1.2.3';

    for (let i = 0; i < 20; i++) {
      const req = createMockRequest('POST', '/api/auth/sign-in/email', ip);
      const res = createMockResponse();
      const next = vi.fn();
      middleware(req, res as unknown as Response, next);
      expect(next).toHaveBeenCalledTimes(1);
    }

    // 21st request must be rejected
    const blockedReq = createMockRequest('POST', '/api/auth/sign-in/email', ip);
    const blockedRes = createMockResponse();
    const nextBlocked = vi.fn();

    middleware(blockedReq, blockedRes as unknown as Response, nextBlocked);

    expect(nextBlocked).not.toHaveBeenCalled();
    expect(blockedRes.statusCode).toBe(429);
    expect(blockedRes.body).toEqual({
      statusCode: 429,
      message: 'Too many requests. Please try again shortly.',
    });
    expect(blockedRes.headers['retry-after']).toBeDefined();
    expect(Number(blockedRes.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('enforces booking and payment mutation limit (30 req / 60s)', () => {
    let fakeTime = 2_000_000;
    const middleware = createRateLimiterMiddleware({
      now: () => fakeTime,
    });
    const ip = '10.1.2.4';

    for (let i = 0; i < 30; i++) {
      const path = i % 2 === 0 ? '/api/appointments' : '/api/payments/orders';
      const req = createMockRequest('POST', path, ip);
      const res = createMockResponse();
      const next = vi.fn();
      middleware(req, res as unknown as Response, next);
      expect(next).toHaveBeenCalledTimes(1);
    }

    // 31st request exceeds limit
    const blockedReq = createMockRequest('POST', '/api/appointments', ip);
    const blockedRes = createMockResponse();
    const nextBlocked = vi.fn();

    middleware(blockedReq, blockedRes as unknown as Response, nextBlocked);

    expect(nextBlocked).not.toHaveBeenCalled();
    expect(blockedRes.statusCode).toBe(429);
    expect(blockedRes.body).toEqual({
      statusCode: 429,
      message: 'Too many requests. Please try again shortly.',
    });
  });

  it('enforces general API limit (120 req / 60s)', () => {
    let fakeTime = 3_000_000;
    const middleware = createRateLimiterMiddleware({
      now: () => fakeTime,
    });
    const ip = '10.1.2.5';

    for (let i = 0; i < 120; i++) {
      const req = createMockRequest('GET', '/api/appointments/availability', ip);
      const res = createMockResponse();
      const next = vi.fn();
      middleware(req, res as unknown as Response, next);
      expect(next).toHaveBeenCalledTimes(1);
    }

    // 121st request exceeds limit
    const blockedReq = createMockRequest('GET', '/api/appointments/availability', ip);
    const blockedRes = createMockResponse();
    const nextBlocked = vi.fn();

    middleware(blockedReq, blockedRes as unknown as Response, nextBlocked);

    expect(nextBlocked).not.toHaveBeenCalled();
    expect(blockedRes.statusCode).toBe(429);
  });

  it('never throttles Razorpay webhooks (exempt tier)', () => {
    let fakeTime = 4_000_000;
    const middleware = createRateLimiterMiddleware({
      now: () => fakeTime,
    });
    const ip = '10.1.2.6';

    // 150 consecutive webhook requests
    for (let i = 0; i < 150; i++) {
      const req = createMockRequest('POST', '/api/payments/webhook', ip);
      const res = createMockResponse();
      const next = vi.fn();
      middleware(req, res as unknown as Response, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(200);
    }
  });

  it('never throttles health check endpoints (exempt tier)', () => {
    let fakeTime = 5_000_000;
    const middleware = createRateLimiterMiddleware({
      now: () => fakeTime,
    });
    const ip = '10.1.2.7';

    for (let i = 0; i < 150; i++) {
      const path = i % 2 === 0 ? '/health' : '/api/health';
      const req = createMockRequest('GET', path, ip);
      const res = createMockResponse();
      const next = vi.fn();
      middleware(req, res as unknown as Response, next);
      expect(next).toHaveBeenCalledTimes(1);
    }
  });

  it('resets rate limits after window expiry', () => {
    let fakeTime = 6_000_000;
    const middleware = createRateLimiterMiddleware({
      now: () => fakeTime,
    });
    const ip = '10.1.2.8';

    // Exhaust 20 auth requests
    for (let i = 0; i < 20; i++) {
      const req = createMockRequest('POST', '/api/auth/sign-in/email', ip);
      const res = createMockResponse();
      middleware(req, res as unknown as Response, vi.fn());
    }

    // Verify blocked at time T
    const blockedRes = createMockResponse();
    middleware(
      createMockRequest('POST', '/api/auth/sign-in/email', ip),
      blockedRes as unknown as Response,
      vi.fn(),
    );
    expect(blockedRes.statusCode).toBe(429);

    // Advance clock past 60-second window
    fakeTime += 61_000;

    // Request must now succeed
    const unblockedRes = createMockResponse();
    const next = vi.fn();
    middleware(
      createMockRequest('POST', '/api/auth/sign-in/email', ip),
      unblockedRes as unknown as Response,
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
    expect(unblockedRes.statusCode).toBe(200);
  });

  it('isolates limits across different client IPs', () => {
    let fakeTime = 7_000_000;
    const middleware = createRateLimiterMiddleware({
      now: () => fakeTime,
    });
    const ipA = '198.51.100.1';
    const ipB = '198.51.100.2';

    // Exhaust ipA
    for (let i = 0; i < 20; i++) {
      middleware(
        createMockRequest('POST', '/api/auth/sign-in/email', ipA),
        createMockResponse() as unknown as Response,
        vi.fn(),
      );
    }

    // ipA is blocked
    const resA = createMockResponse();
    middleware(
      createMockRequest('POST', '/api/auth/sign-in/email', ipA),
      resA as unknown as Response,
      vi.fn(),
    );
    expect(resA.statusCode).toBe(429);

    // ipB is allowed
    const resB = createMockResponse();
    const nextB = vi.fn();
    middleware(
      createMockRequest('POST', '/api/auth/sign-in/email', ipB),
      resB as unknown as Response,
      nextB,
    );
    expect(nextB).toHaveBeenCalledTimes(1);
    expect(resB.statusCode).toBe(200);
  });
});
