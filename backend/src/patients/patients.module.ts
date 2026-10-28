import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AuthSessionGuard } from '../auth/auth-session.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { PatientsController } from './patients.controller.js';
import { PatientsService } from './patients.service.js';

@Module({ imports: [AuthModule], controllers: [PatientsController], providers: [AuthSessionGuard, RolesGuard, PatientsService] })
export class PatientsModule {}
