import { ForbiddenException, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthSessionGuard } from '../auth/auth-session.guard.js';
import { AuthSessionVerifier } from '../auth/auth-session-verifier.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { AssistantService } from './assistant.service.js';
import { AssistantVoiceController } from './assistant-voice.controller.js';
import { AssistantVoiceService } from './assistant-voice.service.js';
import { AssistantTtsService } from './assistant-tts.service.js';

vi.mock('../db/database.js', () => ({ db: {} }));
vi.mock('../auth/auth.js', () => ({ auth: {} }));

describe('voice HTTP authorization', () => {
  let app: INestApplication;
  const verify = vi.fn();
  const eligible = vi.fn();
  const synthesize = vi.fn();
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AssistantVoiceController],
      providers: [AuthSessionGuard, RolesGuard, AssistantVoiceService,
        { provide: AssistantTtsService, useValue: { synthesize } },
        { provide: AuthSessionVerifier, useValue: { getSession: verify } },
        { provide: AssistantService, useValue: { assertEligible: eligible } }],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(async () => { await app.close(); });
  beforeEach(() => { verify.mockReset(); eligible.mockReset(); synthesize.mockReset(); });
  it('guards synthesis and validates its body', async () => {
    verify.mockResolvedValueOnce(null);
    await request(app.getHttpServer()).post('/api/assistant/voice/synthesize').send({ text: 'Hello', language: 'en' }).expect(401);
    const user = { id: 'p', role: 'patient', name: 'Patient', email: 'p@example.test' };
    verify.mockResolvedValue({ user });
    await request(app.getHttpServer()).post('/api/assistant/voice/synthesize').send({ text: 'Hello', language: 'en', extra: true }).expect(400);
    expect(synthesize).not.toHaveBeenCalled();
    synthesize.mockResolvedValue(Buffer.from('audio'));
    const response = await request(app.getHttpServer()).post('/api/assistant/voice/synthesize').send({ text: 'Hello', language: 'en' }).expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-type']).toContain('audio/wav');
    expect(synthesize).toHaveBeenCalledWith(user, 'Hello', 'en');
  });
  it('rejects unauthenticated requests and admin sessions before reading audio', async () => {
    verify.mockResolvedValueOnce(null).mockResolvedValueOnce({ user: { id: 'a', role: 'admin', name: 'Admin', email: 'a@example.test' } });
    await request(app.getHttpServer()).post('/api/assistant/voice/transcribe').expect(401);
    await request(app.getHttpServer()).post('/api/assistant/voice/transcribe').expect(403);
    expect(eligible).not.toHaveBeenCalled();
  });
  it('passes the session identity to eligibility before validating uploads', async () => {
    const user = { id: 'p', role: 'patient', name: 'Patient', email: 'p@example.test' };
    verify.mockResolvedValue({ user }); eligible.mockResolvedValue(undefined);
    await request(app.getHttpServer()).post('/api/assistant/voice/transcribe').expect(400);
    expect(eligible).toHaveBeenCalledWith(user);
  });
  it('denies a doctor whose approval has been revoked', async () => {
    const user = { id: 'd', role: 'doctor', name: 'Doctor', email: 'd@example.test' };
    verify.mockResolvedValue({ user }); eligible.mockRejectedValue(new ForbiddenException());
    await request(app.getHttpServer()).post('/api/assistant/voice/transcribe').expect(403);
    expect(eligible).toHaveBeenCalledWith(user);
  });
});
