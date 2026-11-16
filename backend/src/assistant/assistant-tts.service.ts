import { HttpException, HttpStatus, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { loadEnv } from '../config/env.js';
import { AssistantService } from './assistant.service.js';

const MAX_RESPONSE = 8 * 1024 * 1024;

@Injectable()
export class AssistantTtsService {
  private readonly usage = new Map<string, { starts: number[]; inFlight: boolean }>();
  private active = 0;
  private nextCleanup = 0;
  constructor(private readonly assistant: AssistantService) {}

  async synthesize(actor: AuthenticatedUser, text: string, language: 'en' | 'hi'): Promise<Buffer> {
    try { await this.assistant.assertEligible(actor); }
    catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException('Voice output is temporarily unavailable.');
    }
    const now = Date.now();
    if (now >= this.nextCleanup) {
      for (const [id, value] of this.usage) {
        if (!value.inFlight && value.starts.every((time) => time <= now - 60_000)) this.usage.delete(id);
      }
      this.nextCleanup = now + 60_000;
    }
    const usage = this.usage.get(actor.id) ?? { starts: [], inFlight: false };
    usage.starts = usage.starts.filter((time) => time > now - 60_000);
    if (usage.inFlight || usage.starts.length >= 10) throw new HttpException('Voice request limit reached.', HttpStatus.TOO_MANY_REQUESTS);
    if (this.active >= 8) throw new ServiceUnavailableException('Voice output is busy.');
    usage.starts.push(now); usage.inFlight = true; this.usage.set(actor.id, usage); this.active++;
    try {
      const key = loadEnv().sarvamApiKey;
      if (!key) throw new Error('Unavailable');
      const response = await fetch('https://api.sarvam.ai/text-to-speech', {
        method: 'POST', headers: { 'api-subscription-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({ text, language_code: language === 'hi' ? 'hi-IN' : 'en-IN', model: 'bulbul:v4-flash', output_audio_codec: 'wav' }),
        signal: AbortSignal.timeout(30_000), redirect: 'error',
      });
      if (!response.ok || !response.body || Number(response.headers.get('content-length')) > MAX_RESPONSE) {
        void response.body?.cancel().catch(() => {});
        throw new Error('Unavailable');
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > MAX_RESPONSE) throw new Error('Unavailable');
          chunks.push(value);
        }
      } catch (error) { void reader.cancel().catch(() => {}); throw error; }
      finally { reader.releaseLock(); }
      const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      if (!data || typeof data !== 'object' || !('audios' in data) || !Array.isArray(data.audios) || data.audios.length !== 1 ||
          typeof data.audios[0] !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data.audios[0])) throw new Error('Unavailable');
      const audio = Buffer.from(data.audios[0], 'base64');
      if (audio.length < 44 || !audio.subarray(0, 4).equals(Buffer.from('RIFF')) || !audio.subarray(8, 12).equals(Buffer.from('WAVE'))) throw new Error('Unavailable');
      return audio;
    } catch {
      throw new ServiceUnavailableException('Voice output is temporarily unavailable.');
    } finally { usage.inFlight = false; this.active--; }
  }
}
