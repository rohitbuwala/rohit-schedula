import { Module } from '@nestjs/common';
import { AuthSessionVerifier } from './auth-session-verifier.js';

@Module({
  providers: [AuthSessionVerifier],
  exports: [AuthSessionVerifier],
})
export class AuthModule {}
