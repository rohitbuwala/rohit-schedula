import { EmailService } from './email.service.js';

describe('EmailService', () => {
  const service = new EmailService();
  const payload = { recipientName: 'Test Recipient', amountPaise: 5000, currency: 'INR' };
  const previousKey = process.env.RESEND_API_KEY;
  const previousFrom = process.env.EMAIL_FROM;
  const previousMode = process.env.EMAIL_DELIVERY_MODE;
  const previousTestRecipient = process.env.EMAIL_TEST_RECIPIENT;
  const previousNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (previousKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previousKey;
    if (previousFrom === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = previousFrom;
    if (previousMode === undefined) delete process.env.EMAIL_DELIVERY_MODE;
    else process.env.EMAIL_DELIVERY_MODE = previousMode;
    if (previousTestRecipient === undefined) delete process.env.EMAIL_TEST_RECIPIENT;
    else process.env.EMAIL_TEST_RECIPIENT = previousTestRecipient;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  });

  it('reports delivery disabled when Resend configuration is missing', async () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
    process.env.EMAIL_DELIVERY_MODE = 'disabled';
    const result = await service.sendEvent('payment_receipt', 'test@example.invalid', payload, 'receipt:test');
    expect(result).toEqual({ status: 'disabled' });
  });

  it('sends HTML and text with a stable provider idempotency key', async () => {
    process.env.RESEND_API_KEY = 'test-only-key';
    process.env.EMAIL_FROM = 'Medrella Care <test@example.invalid>';
    process.env.EMAIL_DELIVERY_MODE = 'test';
    process.env.EMAIL_TEST_RECIPIENT = 'qa-sink@example.invalid';
    process.env.NODE_ENV = 'development';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    const result = await service.sendEvent('payment_receipt', 'test@example.invalid', payload, 'receipt:test');
    expect(result).toEqual({ status: 'sent' });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const requestBody = JSON.parse(String(init.body)) as { to: string[]; html: string; text: string };
    expect(init.headers).toMatchObject({ 'Idempotency-Key': 'receipt:test' });
    expect(requestBody.to).toEqual(['qa-sink@example.invalid']);
    expect(requestBody.text).toBeTruthy();
    expect(requestBody.html).toBeTruthy();
    expect(String(init.body)).not.toContain('test-only-key');
  });

  it('treats provider timeout as ambiguous and retryable', async () => {
    process.env.RESEND_API_KEY = 'test-only-key';
    process.env.EMAIL_FROM = 'Medrella Care <test@example.invalid>';
    process.env.EMAIL_DELIVERY_MODE = 'test';
    process.env.EMAIL_TEST_RECIPIENT = 'qa-sink@example.invalid';
    process.env.NODE_ENV = 'development';
    const fetchMock = vi.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await service.sendEvent('payment_receipt', 'test@example.invalid', payload, 'receipt:test');
    expect(result).toEqual({ status: 'retryable', reason: 'request_timeout', ambiguous: true });
  });

  it('never sends from an automated test process even if production settings are present', async () => {
    process.env.RESEND_API_KEY = 'test-only-key';
    process.env.EMAIL_FROM = 'Medrella Care <test@example.invalid>';
    process.env.EMAIL_DELIVERY_MODE = 'production';
    process.env.NODE_ENV = 'test';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await service.sendEvent('payment_receipt', 'real-user@example.com', payload, 'receipt:test');
    expect(result).toEqual({ status: 'disabled' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps appointment reminders disabled in production even when normal email delivery is enabled', async () => {
    process.env.RESEND_API_KEY = 'test-only-key';
    process.env.EMAIL_FROM = 'Medrella Care <test@example.invalid>';
    process.env.EMAIL_DELIVERY_MODE = 'production';
    process.env.NODE_ENV = 'production';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await service.sendEvent('appointment_reminder', 'patient@example.invalid', payload, 'reminder:test');

    expect(result).toEqual({ status: 'disabled' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
