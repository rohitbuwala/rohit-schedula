import { loadEnv } from './env.js';

describe('environment validation', () => {
  beforeEach(() => {
    Object.assign(process.env, {
      DATABASE_URL: 'postgresql://test:test@localhost/test',
      BETTER_AUTH_URL: 'http://localhost:5000',
      FRONTEND_URL: 'http://localhost:3000',
      BETTER_AUTH_SECRET: 'test-only-secret-value-with-at-least-32-characters',
    });
    delete process.env.PORT;
  });

  it('validates configuration and defaults the backend port', () => {
    expect(loadEnv().port).toBe(5000);
  });

  it('rejects weak secrets without echoing their values', () => {
    process.env.BETTER_AUTH_SECRET = 'short-secret';

    try {
      loadEnv();
      throw new Error('Expected invalid environment to be rejected.');
    } catch (error) {
      expect((error as Error).message).toContain('BETTER_AUTH_SECRET');
      expect((error as Error).message).not.toContain('short-secret');
    }
  });

  it('rejects missing required settings without echoing values', () => {
    delete process.env.BETTER_AUTH_SECRET;
    expect(() => loadEnv()).toThrow('BETTER_AUTH_SECRET');
  });

  it('rejects non-PostgreSQL database URLs', () => {
    process.env.DATABASE_URL = 'https://example.com';
    expect(() => loadEnv()).toThrow('DATABASE_URL');
  });
});
