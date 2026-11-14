import { BadRequestException, HttpException, HttpStatus, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { loadEnv } from '../config/env.js';
import { AssistantService } from './assistant.service.js';

export const MAX_WAV_BYTES = 44 + 480_000 * 2;
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 10;
const MAX_CONCURRENT = 8;
const MAX_RESPONSE_BYTES = 16_384;

export function validateAssistantWav(file: { mimetype: string; buffer: Buffer } | undefined): Buffer {
  if (!file || file.mimetype !== 'audio/wav' || !Buffer.isBuffer(file.buffer)) throw new BadRequestException('Provide a PCM WAV recording.');
  const b = file.buffer;
  if (b.length < 46 || b.length > MAX_WAV_BYTES || !b.subarray(0, 4).equals(Buffer.from('RIFF')) ||
      !b.subarray(8, 12).equals(Buffer.from('WAVE')) || !b.subarray(12, 16).equals(Buffer.from('fmt ')) ||
      b.readUInt32LE(4) !== b.length - 8 || b.readUInt32LE(16) !== 16 ||
      b.readUInt16LE(20) !== 1 || b.readUInt16LE(22) !== 1 || b.readUInt32LE(24) !== 16000 ||
      b.readUInt32LE(28) !== 32000 || b.readUInt16LE(32) !== 2 || b.readUInt16LE(34) !== 16 ||
      !b.subarray(36, 40).equals(Buffer.from('data')) || b.readUInt32LE(40) !== b.length - 44 ||
      (b.length - 44) % 2 !== 0) throw new BadRequestException('Invalid or oversized PCM WAV recording.');
  return b;
}

@Injectable()
export class AssistantVoiceService {
  private readonly usage = new Map<string, { starts: number[]; inFlight: boolean }>();
  private active = 0;
  private nextCleanup = 0;

  constructor(private readonly assistant: AssistantService) {}

  async transcribe(actor: AuthenticatedUser, file: { mimetype: string; buffer: Buffer } | undefined) {
    try { await this.assistant.assertEligible(actor); }
    catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException('Voice transcription is temporarily unavailable.');
    }
    const audio = validateAssistantWav(file);
    const now = Date.now();
    if (now >= this.nextCleanup) {
      for (const [id, item] of this.usage) {
        if (!item.inFlight && item.starts.every((time) => time <= now - WINDOW_MS)) this.usage.delete(id);
      }
      this.nextCleanup = now + WINDOW_MS;
    }
    const usage = this.usage.get(actor.id) ?? { starts: [], inFlight: false };
    usage.starts = usage.starts.filter((time) => time > now - WINDOW_MS);
    if (usage.inFlight || usage.starts.length >= MAX_REQUESTS) throw new HttpException('Voice request limit reached.', HttpStatus.TOO_MANY_REQUESTS);
    if (this.active >= MAX_CONCURRENT) throw new ServiceUnavailableException('Voice transcription is busy.');
    usage.starts.push(now);
    usage.inFlight = true;
    this.usage.set(actor.id, usage);
    this.active++;
    try {
      const key = loadEnv().sarvamApiKey;
      if (!key) throw new Error('Unavailable');
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'recording.wav');
      form.append('model', 'saaras:v4');
      form.append('language_code', 'unknown');
      form.append('mode', 'codemix');
      const response = await fetch('https://api.sarvam.ai/speech-to-text', {
        method: 'POST', headers: { 'api-subscription-key': key }, body: form,
        signal: AbortSignal.timeout(30_000), redirect: 'error',
      });
      if (!response.ok || Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES || !response.body) {
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
          if (length > MAX_RESPONSE_BYTES) throw new Error('Unavailable');
          chunks.push(value);
        }
      } catch (error) {
        void reader.cancel().catch(() => {});
        throw error;
      } finally { reader.releaseLock(); }
      const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      if (!body || typeof body !== 'object' || !('transcript' in body) || typeof body.transcript !== 'string' || body.transcript.length > 1000) throw new Error('Unavailable');
      return { transcript: body.transcript };
    } catch {
      throw new ServiceUnavailableException('Voice transcription is temporarily unavailable.');
    } finally {
      usage.inFlight = false;
      this.active--;
    }
  }
}
