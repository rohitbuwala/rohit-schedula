import { Injectable } from '@nestjs/common';
import { auth } from './auth.js';

@Injectable()
export class AuthSessionVerifier {
  getSession(headers: Headers) {
    return auth.api.getSession({ headers, query: { disableCookieCache: true } });
  }
}
