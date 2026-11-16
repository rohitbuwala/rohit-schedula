import { describe, expect, it, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { createSecurityHeadersMiddleware } from './security-headers.js';

interface MockResponse {
  statusCode: number;
  headers: Record<string, string>;
  setHeader: (name: string, value: string) => MockResponse;
  removeHeader: (name: string) => MockResponse;
  status: (code: number) => MockResponse;
  json: (data: unknown) => MockResponse;
}

function createMockResponse(initialHeaders: Record<string, string> = {}): MockResponse {
  const res: MockResponse = {
    statusCode: 200,
    headers: { ...initialHeaders },
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    removeHeader(name: string) {
      delete this.headers[name.toLowerCase()];
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(_data: unknown) {
      return this;
    },
  };
  return res;
}

function createMockRequest(path = '/'): Request {
  return {
    path,
    url: path,
    headers: {},
  } as unknown as Request;
}

describe('Security Headers Middleware (Unit & Lifecycle)', () => {
  it('sets X-Content-Type-Options: nosniff', () => {
    const middleware = createSecurityHeadersMiddleware({ isProduction: false });
    const req = createMockRequest('/health');
    const res = createMockResponse();
    const next = vi.fn();

    middleware(req, res as unknown as Response, next);

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('sets X-Frame-Options: DENY', () => {
    const middleware = createSecurityHeadersMiddleware({ isProduction: false });
    const req = createMockRequest('/api/appointments');
    const res = createMockResponse();
    const next = vi.fn();

    middleware(req, res as unknown as Response, next);

    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('sets Referrer-Policy: strict-origin-when-cross-origin', () => {
    const middleware = createSecurityHeadersMiddleware({ isProduction: false });
    const req = createMockRequest('/api/payments/orders');
    const res = createMockResponse();
    const next = vi.fn();

    middleware(req, res as unknown as Response, next);

    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('omits Strict-Transport-Security in non-production mode', () => {
    const middleware = createSecurityHeadersMiddleware({ isProduction: false });
    const req = createMockRequest('/health');
    const res = createMockResponse();
    const next = vi.fn();

    middleware(req, res as unknown as Response, next);

    expect(res.headers['strict-transport-security']).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('sets Strict-Transport-Security when isProduction is true', () => {
    const middleware = createSecurityHeadersMiddleware({ isProduction: true });
    const req = createMockRequest('/api/appointments');
    const res = createMockResponse();
    const next = vi.fn();

    middleware(req, res as unknown as Response, next);

    expect(res.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('removes X-Powered-By if present on response', () => {
    const middleware = createSecurityHeadersMiddleware();
    const req = createMockRequest('/health');
    const res = createMockResponse({ 'x-powered-by': 'Express' });
    const next = vi.fn();

    middleware(req, res as unknown as Response, next);

    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('preserves security headers across simulated error response handlers', () => {
    const middleware = createSecurityHeadersMiddleware({ isProduction: true });
    const req = createMockRequest('/error');
    const res = createMockResponse({ 'x-powered-by': 'Express' });
    let errorHandled = false;

    const next: NextFunction = (err?: unknown) => {
      if (err) {
        res.status(500).json({ error: 'Internal Server Error' });
        errorHandled = true;
      }
    };

    middleware(req, res as unknown as Response, () => {
      next(new Error('Simulated exception in route'));
    });

    expect(errorHandled).toBe(true);
    expect(res.statusCode).toBe(500);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(res.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('preserves security headers on simulated 404 not found handler', () => {
    const middleware = createSecurityHeadersMiddleware({ isProduction: false });
    const req = createMockRequest('/unknown-path');
    const res = createMockResponse({ 'x-powered-by': 'Express' });

    middleware(req, res as unknown as Response, () => {
      res.status(404).json({ error: 'Not Found' });
    });

    expect(res.statusCode).toBe(404);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
