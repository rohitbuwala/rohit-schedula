import { memoryAdapter } from '@better-auth/memory-adapter';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

describe('Better Auth HTTP lifecycle', () => {
  let app: INestApplication;

  beforeAll(async () => {
    Object.assign(process.env, {
      DATABASE_URL: 'postgresql://test:test@localhost/test',
      BETTER_AUTH_SECRET: 'test-only-secret-value-with-at-least-32-characters',
      BETTER_AUTH_URL: 'http://localhost:5000',
      FRONTEND_URL: 'http://localhost:3000',
    });

    const [{ default: express }, { createAuth }, { registerAuthHandler }] = await Promise.all([
      import('express'),
      import('./auth.js'),
      import('./auth-handler.js'),
    ]);
    const testDatabase = { user: [], session: [], account: [], verification: [] };
    const testAuth = createAuth(memoryAdapter(testDatabase));
    const testingModule = await Test.createTestingModule({}).compile();
    app = testingModule.createNestApplication({ bodyParser: false, logger: false });
    app.enableCors({ origin: 'http://localhost:3000', credentials: true });
    registerAuthHandler(app.getHttpAdapter().getInstance(), testAuth);
    app.use(express.json());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('signs up, logs in, logs out, retrieves sessions, and prevents client role escalation', async () => {
    const credentials = {
      email: `patient-${Date.now()}@example.com`,
      password: 'test-password-strong-enough',
      name: 'Test Patient',
    };

    const http = request(app.getHttpServer());
    const signup = await http
      .post('/api/auth/sign-up/email')
      .send({ ...credentials, role: 'admin' })
      .expect(200);
    expect(signup.body.user.role).toBe('patient');
    const signupCookie = cookieHeader(signup.headers['set-cookie']);

    const signupSession = await http
      .get('/api/auth/get-session')
      .set('Cookie', signupCookie)
      .expect(200);
    expect(signupSession.body.user.role).toBe('patient');

    await http.post('/api/auth/sign-out').set('Cookie', signupCookie).expect(200);
    await http.get('/api/auth/get-session').set('Cookie', signupCookie).expect(200, null);

    const login = await http.post('/api/auth/sign-in/email').send(credentials).expect(200);
    const loginCookie = cookieHeader(login.headers['set-cookie']);
    const loginSession = await http
      .get('/api/auth/get-session')
      .set('Cookie', loginCookie)
      .expect(200);
    expect(loginSession.body.user.role).toBe('patient');

    await http.post('/api/auth/sign-out').set('Cookie', loginCookie).expect(200);
    await http.get('/api/auth/get-session').set('Cookie', loginCookie).expect(200, null);
  });
});

function cookieHeader(setCookie: string[] | undefined): string {
  if (!setCookie?.length) throw new Error('Expected Better Auth to set a session cookie.');
  return setCookie.map((cookie) => cookie.split(';', 1)[0]).join('; ');
}
