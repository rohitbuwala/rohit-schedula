import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { AuthSessionGuard } from './auth-session.guard.js';
import { RolesGuard } from './roles.guard.js';
import { DoctorApprovedGuard } from '../doctors/doctor-approved.guard.js';

describe('AuthSessionGuard', () => {
  it('accepts a server-verified staff session and ignores client role headers', async () => {
    const guard = new AuthSessionGuard({ getSession: async () => ({
      user: { id: 'staff-1', name: 'Staff', email: 'staff@example.test', role: 'staff' },
    }) } as never);
    const request = { headers: { 'x-role': 'admin' } };
    await expect(guard.canActivate(context(request))).resolves.toBe(true);
    expect(request).toHaveProperty('authUser.role', 'staff');
  });

  it('rejects unknown roles rather than treating them as staff', async () => {
    const guard = new AuthSessionGuard({ getSession: async () => ({
      user: { id: 's1', name: 'Staff', email: 'staff@example.test', role: 'reception' },
    }) } as never);
    await expect(guard.canActivate(context({ headers: {} }))).rejects.toBeInstanceOf(UnauthorizedException);
  });
  it('rejects missing sessions', async () => {
    const guard = new AuthSessionGuard({ getSession: async () => null } as never);
    await expect(guard.canActivate(context({ headers: {} }))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('attaches the role read from the verified Better Auth session', async () => {
    const guard = new AuthSessionGuard({
      getSession: async (headers: Headers) => {
        expect(headers.get('cookie')).toBe('better-auth.session_token=verified');
        return { user: { id: 'doctor-1', name: 'Dr Test', email: 'doctor@example.test', role: 'doctor' } };
      },
    } as never);
    const request = { headers: { cookie: 'better-auth.session_token=verified' } };
    await expect(guard.canActivate(context(request))).resolves.toBe(true);
    expect(request).toHaveProperty('authUser.role', 'doctor');
  });
});

describe('RolesGuard', () => {
  it('allows only the required server-verified role', () => {
    const guard = new RolesGuard({ getAllAndOverride: () => ['admin'] } as never);
    expect(() => guard.canActivate(roleContext({ id: 'p1', name: 'Patient', email: 'p@example.test', role: 'patient' }))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(roleContext({ id: 's1', name: 'Staff', email: 's@example.test', role: 'staff' }))).toThrow(ForbiddenException);
    expect(guard.canActivate(roleContext({ id: 'a1', name: 'Admin', email: 'a@example.test', role: 'admin' }))).toBe(true);
  });
});

describe('DoctorApprovedGuard', () => {
  it('blocks doctors without an approved profile', async () => {
    const guard = new DoctorApprovedGuard({ isApproved: async () => false } as never);
    await expect(guard.canActivate(roleContext({ id: 'd1', name: 'Doctor', email: 'd@example.test', role: 'doctor' }))).rejects.toBeInstanceOf(ForbiddenException);
  });
});

function context(request: object): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

function roleContext(authUser: { id: string; name: string; email: string; role: 'patient' | 'doctor' | 'admin' | 'staff' }): ExecutionContext {
  return { ...context({ authUser }), getHandler: () => ({}), getClass: () => ({}) } as ExecutionContext;
}
