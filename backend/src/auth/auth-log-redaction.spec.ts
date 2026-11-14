import { InternalServerErrorException, Logger } from '@nestjs/common';
import { auth } from './auth.js';
import { AuthSessionVerifier } from './auth-session-verifier.js';

vi.mock('../db/database.js', () => ({ db: {} }));
vi.mock('../config/env.js', () => ({
  loadEnv: () => ({
    betterAuthUrl: 'http://localhost:5000',
    frontendUrl: 'http://localhost:3000',
    betterAuthSecret: 'test-only-secret-value-with-at-least-32-characters',
  }),
}));

describe('auth error log redaction', () => {
  afterEach(() => vi.restoreAllMocks());

  it('drops Better Auth messages and all error arguments before logging', () => {
    const errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    const warnLog = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const log = auth.options.logger?.log;
    expect(log).toBeTypeOf('function');
    log?.('error', 'private-session-token', new Error('Failed query: private-account-id', {
      cause: new Error('private-cookie-value'),
    }));
    log?.('warn', 'private-session-token', { headers: { cookie: 'private-cookie-value' } });
    expect(errorLog.mock.calls).toEqual([['Authentication operation failed.']]);
    expect(warnLog.mock.calls).toEqual([['Authentication warning.']]);
  });

  it('prevents a raw session lookup failure from reaching the Nest exception logger', async () => {
    vi.spyOn(auth.api, 'getSession').mockRejectedValue(new Error('private-session-token', {
      cause: new Error('private-account-id'),
    }));
    const error = await new AuthSessionVerifier().getSession(new Headers()).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(InternalServerErrorException);
    expect(error).toMatchObject({ message: 'Unable to verify session.', cause: undefined });
  });
});
