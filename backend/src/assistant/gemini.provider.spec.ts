import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { loadEnv } from '../config/env.js';
import { GeminiProvider } from './gemini.provider.js';

vi.mock('../config/env.js', () => ({ loadEnv: vi.fn() }));

describe('Gemini provider', () => {
  const fetchMock = vi.fn();
  const provider = new GeminiProvider();
  const tools = { list_appointments: 'List appointments' };

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(loadEnv).mockReturnValue({ geminiApiKey: 'test-key', geminiModel: 'gemini-test', geminiTimeoutMs: 20000 } as never);
  });

  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('sends only the intent and tool declarations and extracts one function call', async () => {
    const functionCall = { name: 'list_appointments', args: {} };
    fetchMock.mockResolvedValue(Response.json({ candidates: [{ content: { parts: [{ functionCall }] } }] }));
    await expect(provider.selectTool('my appointments', tools)).resolves.toEqual(functionCall);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent');
    expect(init.headers['x-goog-api-key']).toBe('test-key');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body)).toMatchObject({
      contents: [{ role: 'user', parts: [{ text: 'my appointments' }] }],
      toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['list_appointments'] } },
      generationConfig: { maxOutputTokens: 256 },
    });
  });

  it('fails closed when configuration is absent', async () => {
    vi.mocked(loadEnv).mockReturnValue({} as never);
    await expect(provider.selectTool('appointments', tools)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('identifies a missing model without logging the configured key or prompt', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.mocked(loadEnv).mockReturnValue({ geminiApiKey: 'private-key' } as never);
    await expect(provider.selectTool('private prompt', tools)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn.mock.calls).toEqual([['Gemini is not configured. Missing: GEMINI_MODEL.']]);
  });

  it('handles a timed-out request without returning upstream details', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const signal = AbortSignal.abort(new DOMException('private upstream message', 'TimeoutError'));
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(signal);
    fetchMock.mockImplementation(async (_url, init) => { init.signal.throwIfAborted(); });
    await expect(provider.selectTool('appointments', tools)).rejects.toThrow('Assistant is temporarily unavailable.');
    expect(timeout).toHaveBeenCalledWith(20000);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(warn.mock.calls).toEqual([[expect.stringMatching(
      /^Gemini tool selection failed: category=deadline exceeded code=none elapsedMs=\d+ aborted=true$/,
    )]]);
  });

  it('applies a configured overall timeout and does not retry after it expires', async () => {
    const signal = AbortSignal.abort(new DOMException('secret', 'TimeoutError'));
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(signal);
    vi.mocked(loadEnv).mockReturnValue({ geminiApiKey: 'test-key', geminiModel: 'gemini-test', geminiTimeoutMs: 12000 } as never);
    fetchMock.mockImplementation(async (_url, init) => { init.signal.throwIfAborted(); });
    await expect(provider.selectTool('appointments', tools)).rejects.toThrow('Assistant is temporarily unavailable.');
    expect(timeout).toHaveBeenCalledWith(12000);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    ['ENOTFOUND', 'dns'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls'],
    ['ECONNRESET', 'connection reset'],
    ['UND_ERR_CONNECT_TIMEOUT', 'transport timeout'],
  ])('classifies %s from nested causes without logging raw errors', async (code, category) => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const nested = Object.assign(new Error('private connection details'), { code });
    fetchMock.mockRejectedValue(new TypeError('private request', {
      cause: new AggregateError([nested], 'private aggregate'),
    }));
    await expect(provider.selectTool('private prompt', tools)).rejects.toThrow('Assistant is temporarily unavailable.');
    expect(warn.mock.calls).toEqual([[expect.stringMatching(new RegExp(
      `^Gemini tool selection failed: category=${category} code=${code} elapsedMs=\\d+ aborted=false$`,
    ))]]);
  });

  it('does not echo an unknown transport code', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    fetchMock.mockRejectedValue(Object.assign(new Error('private error'), { code: 'private-code' }));
    await expect(provider.selectTool('appointments', tools)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(warn.mock.calls).toEqual([[expect.stringMatching(
      /^Gemini tool selection failed: category=transport failure code=none elapsedMs=\d+ aborted=false$/,
    )]]);
  });

  it('does not retry when retry-after exceeds the configured overall deadline', async () => {
    vi.mocked(loadEnv).mockReturnValue({ geminiApiKey: 'test-key', geminiModel: 'gemini-test', geminiTimeoutMs: 1000 } as never);
    fetchMock.mockResolvedValue(new Response(null, { status: 429, headers: { 'Retry-After': '2' } }));
    await expect(provider.selectTool('appointments', tools)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    { parts: [] },
    { parts: [{ text: 'An invented answer' }] },
    { parts: [{ functionCall: { name: 'first' } }, { functionCall: { name: 'second' } }] },
  ])('rejects missing or multiple calls', async ({ parts }) => {
    fetchMock.mockResolvedValue(Response.json({ candidates: [{ content: { parts } }] }));
    await expect(provider.selectTool('appointments', tools)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('does not expose an upstream error body', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    fetchMock.mockResolvedValue(new Response('private upstream error', {
      status: 429, headers: { 'Retry-After': '60' },
    }));
    await expect(provider.selectTool('appointments', tools)).rejects.toThrow('Assistant is temporarily unavailable.');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(warn.mock.calls).toEqual([[expect.stringMatching(
      /^Gemini tool selection failed: category=upstream HTTP code=429 elapsedMs=\d+ aborted=false$/,
    )]]);
  });

  it.each([503, 429])('recovers from HTTP %s within the original deadline', async (status) => {
    const functionCall = { name: 'list_appointments', args: {} };
    const started = performance.now();
    fetchMock
      .mockResolvedValueOnce(new Response(null, {
        status, headers: { 'Retry-After': status === 429 ? '1' : '0' },
      }))
      .mockResolvedValueOnce(Response.json({ candidates: [{ content: { parts: [{ functionCall }] } }] }));
    await expect(provider.selectTool('appointments', tools)).resolves.toEqual(functionCall);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].signal).toBe(fetchMock.mock.calls[0][1].signal);
    expect(performance.now() - started).toBeGreaterThanOrEqual(status === 429 ? 990 : 240);
  });

  it('retries a nested connection timeout that arrives before the deadline', async () => {
    const functionCall = { name: 'list_appointments' };
    fetchMock
      .mockRejectedValueOnce(new TypeError('private error', {
        cause: Object.assign(new Error('private cause'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
      }))
      .mockResolvedValueOnce(Response.json({ candidates: [{ content: { parts: [{ functionCall }] } }] }));
    await expect(provider.selectTool('appointments', tools)).resolves.toEqual(functionCall);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([[503, 2], [401, 1], [404, 1]])('limits attempts on repeated HTTP %s', async (status, attempts) => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    fetchMock.mockImplementation(async () => new Response(null, { status }));
    await expect(provider.selectTool('appointments', tools)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetchMock).toHaveBeenCalledTimes(attempts);
  });

  it('does not retry if the deadline aborts during backoff', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    fetchMock.mockImplementationOnce(async () => {
      setTimeout(() => controller.abort(), 0);
      return new Response(null, { status: 503 });
    });
    await expect(provider.selectTool('appointments', tools)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(
      /^Gemini tool selection failed: category=deadline exceeded code=503 elapsedMs=\d+ aborted=true$/,
    ));
  });

  it('cancels an oversized streamed response without exposing its contents', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(64 * 1024 + 1)); },
      cancel,
    });
    fetchMock.mockResolvedValue(new Response(body));
    await expect(provider.selectTool('appointments', tools)).rejects.toThrow('Assistant is temporarily unavailable.');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('rejects an oversized declared response before reading it', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    fetchMock.mockResolvedValue(new Response(body, { headers: { 'Content-Length': '65537' } }));
    await expect(provider.selectTool('appointments', tools)).rejects.toThrow('Assistant is temporarily unavailable.');
    expect(cancel).toHaveBeenCalledOnce();
  });
});
