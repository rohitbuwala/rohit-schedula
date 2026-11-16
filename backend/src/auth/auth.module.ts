import { Module } from '@nestjs/common';
import { AuthSessionVerifier } from './auth-session-verifier.js';
import { AuthSessionGuard } from './auth-session.guard.js';
import { RolesGuard } from './roles.guard.js';
import { StaffAccessController, StaffRegistrationController } from './staff-access.controller.js';
import { StaffAccessService } from './staff-access.service.js';

@Module({
  controllers: [StaffAccessController, StaffRegistrationController],
  providers: [AuthSessionVerifier, AuthSessionGuard, RolesGuard, StaffAccessService],
  exports: [AuthSessionVerifier, StaffAccessService],
})
export class AuthModule {}
