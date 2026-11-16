import { setTimeout as sleep } from 'node:timers/promises';
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';
import { loadEnv } from '../config/env.js';
import type { AssistantProvider } from './assistant-provider.js';

const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024;
const RETRYABLE_TRANSPORT_CODES = new Set([
  'EAI_AGAIN',
  'ECONNRESET',
  'ETIMEDOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);
const TRANSPORT_CATEGORIES = new Map([
  ['ENOTFOUND', 'dns'],
  ['EAI_AGAIN', 'dns'],
  ['CERT_HAS_EXPIRED', 'tls'],
  ['DEPTH_ZERO_SELF_SIGNED_CERT', 'tls'],
  ['SELF_SIGNED_CERT_IN_CHAIN', 'tls'],
  ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'tls'],
  ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'tls'],
  ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls'],
  ['ERR_SSL_WRONG_VERSION_NUMBER', 'tls'],
  ['ECONNRESET', 'connection reset'],
  ['ECONNREFUSED', 'connection refused'],
  ['ENETUNREACH', 'network unreachable'],
  ['EHOSTUNREACH', 'network unreachable'],
  ['EACCES', 'network access denied'],
  ['EPERM', 'network access denied'],
  ['UND_ERR_SOCKET', 'socket failure'],
  ['ETIMEDOUT', 'transport timeout'],
  ['UND_ERR_CONNECT_TIMEOUT', 'transport timeout'],
  ['UND_ERR_HEADERS_TIMEOUT', 'transport timeout'],
  ['UND_ERR_BODY_TIMEOUT', 'transport timeout'],
  ['ABORT_ERR', 'transport aborted'],
  ['UND_ERR_ABORTED', 'transport aborted'],
]);

function transportFailure(error: unknown) {
  const pending = [error];
  const seen = new Set<unknown>();
  for (let i = 0; i < pending.length && i < 16; i++) {
    const entry = pending[i];
    if (!(entry instanceof Error) || seen.has(entry)) continue;
    seen.add(entry);
    if ('code' in entry && typeof entry.code === 'string') {
      const category = TRANSPORT_CATEGORIES.get(entry.code);
      if (category) return { category, code: entry.code };
    }
    pending.push(entry.cause);
    if (entry instanceof AggregateError) pending.push(...entry.errors.slice(0, 8));
  }
  return undefined;
}

function retryDelayMs(retryAfter: string | null) {
  const backoff = 250 + Math.floor(Math.random() * 250);
  if (!retryAfter) return backoff;
  const requestedDelay = /^\d+$/.test(retryAfter)
    ? Number(retryAfter) * 1000
    : Date.parse(retryAfter) - Date.now();
  return Number.isNaN(requestedDelay) ? backoff : Math.max(backoff, requestedDelay);
}

const responseSchema = z.object({
  candidates: z.array(z.object({
    content: z.object({
      parts: z.array(z.object({ functionCall: z.unknown().optional() })),
    }),
  })).length(1),
});

async function readProviderResponse(response: Response): Promise<unknown> {
  if (!response.ok || Number(response.headers.get('content-length')) > MAX_PROVIDER_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw new Error('Gemini response rejected');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Gemini returned no response body');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let json = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_PROVIDER_RESPONSE_BYTES) throw new Error('Gemini response exceeds size limit');
      json += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(json + decoder.decode()) as unknown;
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

@Injectable()
export class GeminiProvider implements AssistantProvider {
  private readonly logger = new Logger(GeminiProvider.name);

  async selectTool(intent: string, tools: Readonly<Record<string, string>>) {
    const { geminiApiKey, geminiModel, geminiTimeoutMs } = loadEnv();
    if (!geminiApiKey || !geminiModel) {
      const missing = [!geminiApiKey && 'GEMINI_API_KEY', !geminiModel && 'GEMINI_MODEL'].filter(Boolean);
      this.logger.warn(`Gemini is not configured. Missing: ${missing.join(', ')}.`);
      throw new ServiceUnavailableException('Assistant is unavailable.');
    }
    const startedAt = performance.now();
    const signal = AbortSignal.timeout(geminiTimeoutMs);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent`;
    const request: RequestInit = {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiApiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{
          text: 'Classify these scheduling keywords. Select exactly one tool. Use clarify for write requests, ambiguity, or unrelated requests. Do not generate arguments.',
        }] },
        contents: [{ role: 'user', parts: [{ text: intent }] }],
        tools: [{
          functionDeclarations: Object.entries(tools).map(([name, description]) => ({
            name,
            description,
          })),
        }],
        toolConfig: {
          functionCallingConfig: { mode: 'ANY', allowedFunctionNames: Object.keys(tools) },
        },
        generationConfig: { maxOutputTokens: 256 },
      }),
    };
    for (let attempt = 0; ; attempt++) {
      let failure = 'transport failure';
      let upstreamStatus: number | undefined;
      let retryAfter: string | null = null;
      try {
        const response = await fetch(url, request);
        if (!response.ok) {
          upstreamStatus = response.status;
          retryAfter = response.headers.get('retry-after');
        }
        failure = 'invalid or oversized response';
        const result = responseSchema.parse(await readProviderResponse(response));
        const calls = result.candidates[0].content.parts.flatMap(({ functionCall }) =>
          functionCall === undefined ? [] : [functionCall],
        );
        if (calls.length !== 1) {
          failure = 'unexpected number of tool selections';
          throw new Error('Expected one tool selection');
        }
        return calls[0];
      } catch (error) {
        const transport = transportFailure(error);
        const retryable = upstreamStatus !== undefined
          ? upstreamStatus === 429 || upstreamStatus === 503
          : transport !== undefined && RETRYABLE_TRANSPORT_CODES.has(transport.code);
        if (attempt === 0 && retryable && !signal.aborted) {
          const delay = retryDelayMs(retryAfter);
          if (performance.now() - startedAt + delay < geminiTimeoutMs) {
            await sleep(delay, undefined, { signal }).catch(() => {});
            if (!signal.aborted && performance.now() - startedAt < geminiTimeoutMs) continue;
          }
        }
        const category = signal.aborted ? 'deadline exceeded' : upstreamStatus !== undefined ? 'upstream HTTP' : transport?.category ?? failure;
        const code = upstreamStatus ?? transport?.code ?? 'none';
        const elapsedMs = Math.round(performance.now() - startedAt);
        this.logger.warn(`Gemini tool selection failed: category=${category} code=${code} elapsedMs=${elapsedMs} aborted=${signal.aborted}`);
        throw new ServiceUnavailableException('Assistant is temporarily unavailable.');
      }
    }
  }
}
