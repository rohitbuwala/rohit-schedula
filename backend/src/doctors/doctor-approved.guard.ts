import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/authenticated-user.js';
import { DoctorProfilesService } from './doctor-profiles.service.js';

@Injectable()
export class DoctorApprovedGuard implements CanActivate {
  constructor(private readonly profiles: DoctorProfilesService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const user = context.switchToHttp().getRequest<AuthenticatedRequest>().authUser;
    if (!user || user.role !== 'doctor' || !(await this.profiles.isApproved(user.id))) throw new ForbiddenException();
    return true;
  }
}
