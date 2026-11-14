import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { AssistantTtsService } from './assistant-tts.service.js';
vi.mock('../db/database.js', () => ({ db: {} }));
vi.mock('../config/env.js', () => ({ loadEnv: () => ({ sarvamApiKey: 'test-secret' }) }));
const actor: AuthenticatedUser = { id: 'p', name: 'Test', email: 'test@example.test', role: 'patient' };
const wav = Buffer.alloc(44); wav.write('RIFF'); wav.write('WAVE', 8);
describe('Sarvam TTS', () => {
  const eligible = vi.fn();
  let service: AssistantTtsService;
  beforeEach(() => { eligible.mockReset().mockResolvedValue(undefined); service = new AssistantTtsService({ assertEligible: eligible } as never); });
  afterEach(() => vi.unstubAllGlobals());
  it.each([['en', 'en-IN'], ['hi', 'hi-IN']] as const)('uses fixed model and %s language', async (language, expected) => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ audios: [wav.toString('base64')] }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await service.synthesize(actor, 'Hello', language)).toEqual(wav);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.sarvam.ai/text-to-speech');
    expect(JSON.parse(options.body)).toEqual({ text: 'Hello', language_code: expected, model: 'bulbul:v4-flash', output_audio_codec: 'wav' });
  });
  it('rejects ineligible users without a provider call', async () => {
    eligible.mockRejectedValue(new ForbiddenException());
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    await expect(service.synthesize(actor, 'Hello', 'en')).rejects.toBeInstanceOf(ForbiddenException);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('sanitizes upstream errors and rejects invalid audio', async () => {
    for (const response of [new Response('private content', { status: 503 }), Response.json({ audios: ['invalid'] })]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
      await expect(service.synthesize(actor, 'private text', 'en')).rejects.toThrow('Voice output is temporarily unavailable.');
    }
  });
  it('limits concurrent requests and releases the slot after failure', async () => {
    let resolve!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; })).mockResolvedValue(new Response(null, { status: 503 })));
    const first = service.synthesize(actor, 'Hello', 'en');
    await vi.waitFor(() => expect(resolve).toBeDefined());
    await expect(service.synthesize(actor, 'Hello', 'en')).rejects.toMatchObject({ status: 429 });
    resolve(new Response(null, { status: 503 }));
    await expect(first).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(service.synthesize(actor, 'Hello', 'en')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
