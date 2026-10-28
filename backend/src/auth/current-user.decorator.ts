import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { AuthenticatedRequest } from './authenticated-user.js';

export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const user = context.switchToHttp().getRequest<AuthenticatedRequest>().authUser;
  if (!user) throw new UnauthorizedException();
  return user;
});
