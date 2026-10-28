import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedRequest, UserRole } from './authenticated-user.js';
import { REQUIRED_ROLES } from './roles.decorator.js';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<UserRole[]>(REQUIRED_ROLES, [context.getHandler(), context.getClass()]);
    if (!roles?.length) return true;
    const user = context.switchToHttp().getRequest<AuthenticatedRequest>().authUser;
    if (!user || !roles.includes(user.role)) throw new ForbiddenException();
    return true;
  }
}
