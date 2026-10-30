export type UserRole = 'patient' | 'doctor' | 'admin';

export interface AuthenticatedUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
}

export interface AuthenticatedRequest {
  headers: import('node:http').IncomingHttpHeaders;
  authUser?: AuthenticatedUser;
}
