import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { auth } from './auth.js';

@Injectable()
export class AuthSessionVerifier {
  async getSession(headers: Headers) {
    try {
      return await auth.api.getSession({ headers, query: { disableCookieCache: true } });
    } catch {
      // Never let an adapter error or its cause reach Nest's exception logger.
      throw new InternalServerErrorException('Unable to verify session.');
    }
  }
}
