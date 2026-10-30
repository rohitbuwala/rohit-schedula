import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { fromNodeHeaders } from 'better-auth/node';
import { z } from 'zod';
import type { AuthenticatedRequest } from './authenticated-user.js';
import { AuthSessionVerifier } from './auth-session-verifier.js';

const authenticatedUserSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  email: z.email(),
  role: z.enum(['patient', 'doctor', 'admin']),
});

@Injectable()
export class AuthSessionGuard implements CanActivate {
  constructor(private readonly verifier: AuthSessionVerifier) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const session = await this.verifier.getSession(fromNodeHeaders(request.headers));
    const user = session ? authenticatedUserSchema.safeParse(session.user) : null;
    if (!user?.success) throw new UnauthorizedException();
    request.authUser = user.data;
    return true;
  }
}
