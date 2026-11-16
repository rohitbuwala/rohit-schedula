import { BadRequestException, ForbiddenException, HttpException, ServiceUnavailableException } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { AssistantVoiceService, MAX_WAV_BYTES, validateAssistantWav } from './assistant-voice.service.js';

vi.mock('../db/database.js', () => ({ db: {} }));
vi.mock('../config/env.js', () => ({ loadEnv: () => ({ sarvamApiKey: 'private-test-key' }) }));

const patient: AuthenticatedUser = { id: 'patient', role: 'patient', name: 'Test', email: 'test@example.test' };
function wav(samples = 2) {
  const b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(b.length - 44, 40);
  return { mimetype: 'audio/wav', buffer: b };
}

describe('assistant voice', () => {
  const assertEligible = vi.fn();
  let service: AssistantVoiceService;
  beforeEach(() => {
    vi.restoreAllMocks();
    assertEligible.mockReset().mockResolvedValue(undefined);
    service = new AssistantVoiceService({ assertEligible } as never);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('validates exact PCM format and actual duration', () => {
    expect(validateAssistantWav(wav(480000)).length).toBe(MAX_WAV_BYTES);
    expect(() => validateAssistantWav(wav(480001))).toThrow(BadRequestException);
    expect(() => validateAssistantWav({ ...wav(), mimetype: 'audio/webm' })).toThrow(BadRequestException);
    for (const [offset, size, value] of [[20, 2, 3], [22, 2, 2], [24, 4, 8000], [34, 2, 8], [40, 4, 0]] as const) {
      const file = wav();
      if (size === 2) file.buffer.writeUInt16LE(value, offset); else file.buffer.writeUInt32LE(value, offset);
      expect(() => validateAssistantWav(file)).toThrow(BadRequestException);
    }
    expect(() => validateAssistantWav({ mimetype: 'audio/wav', buffer: Buffer.alloc(10) })).toThrow(BadRequestException);
  });

  it('sends only validated audio with fixed Sarvam options and returns the transcript', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ transcript: 'hello', request_id: 'private' })));
    vi.stubGlobal('fetch', fetchMock);
    await expect(service.transcribe(patient, wav())).resolves.toEqual({ transcript: 'hello' });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.sarvam.ai/speech-to-text');
    expect(options.body.get('model')).toBe('saaras:v4');
    expect(options.body.get('language_code')).toBe('unknown');
    expect(options.body.get('mode')).toBe('codemix');
    expect(options.body.get('file').size).toBe(48);
    expect(assertEligible).toHaveBeenCalledWith(patient);
  });

  it('rejects ineligible users before contacting Sarvam', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    assertEligible.mockRejectedValue(new ForbiddenException());
    await expect(service.transcribe({ ...patient, role: 'doctor' }, wav())).rejects.toBeInstanceOf(ForbiddenException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('limits concurrent and repeated requests and releases the slot after errors', async () => {
    let complete!: (response: Response) => void;
    const fetchMock = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { complete = resolve; }))
      .mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const first = service.transcribe(patient, wav());
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await expect(service.transcribe(patient, wav())).rejects.toMatchObject({ status: 429 });
    complete(new Response(null, { status: 503 }));
    await expect(first).rejects.toBeInstanceOf(ServiceUnavailableException);
    for (let i = 0; i < 9; i++) await expect(service.transcribe(patient, wav())).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(service.transcribe(patient, wav())).rejects.toBeInstanceOf(HttpException);
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it('sanitizes provider failures and rejects malformed or oversized responses', async () => {
    for (const result of [new Error('secret audio transcript'), new Response('secret', { status: 503 }), new Response(JSON.stringify({ transcript: 'x'.repeat(1001) })), new Response('x'.repeat(17000))]) {
      vi.stubGlobal('fetch', result instanceof Error ? vi.fn().mockRejectedValue(result) : vi.fn().mockResolvedValue(result));
      await expect(service.transcribe(patient, wav())).rejects.toThrow('Voice transcription is temporarily unavailable.');
    }
  });
});
