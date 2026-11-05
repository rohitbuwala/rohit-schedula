import { renderEmailTemplate } from './email-templates.js';

describe('email templates', () => {
  const payload = {
    recipientName: '<Patient & Co>',
    otherPartyName: 'Dr. "Example" <script>',
    startsAt: '2026-12-01T10:00:00.000Z',
    timezone: 'Asia/Kolkata',
    amountPaise: 12500,
    currency: 'INR',
    arn: 'ARN-TEST-123',
  };

  it.each([
    ['booking_confirmation', 'Appointment confirmed'],
    ['payment_receipt', 'Payment received'],
    ['appointment_cancelled', 'Appointment cancelled'],
    ['appointment_rescheduled', 'Appointment rescheduled'],
    ['refund_processed', 'Refund processed'],
    ['appointment_reminder', 'Upcoming appointment reminder'],
  ] as const)('renders %s in HTML and plain text', (eventType, heading) => {
    const rendered = renderEmailTemplate(eventType, payload);
    expect(rendered.subject).toBeTruthy();
    expect(rendered.html).toContain(heading);
    expect(rendered.text).toContain('Hello <Patient & Co>');
    expect(rendered.html).toContain('&lt;Patient &amp; Co&gt;');
    expect(rendered.html).not.toContain('<script>');
  });

  it('includes refund amount and ARN only when present', () => {
    const withArn = renderEmailTemplate('refund_processed', payload);
    expect(withArn.html).toContain('ARN-TEST-123');
    expect(withArn.text).toContain('ARN: ARN-TEST-123');

    const withoutArn = renderEmailTemplate('refund_processed', { ...payload, arn: null });
    expect(withoutArn.html).not.toContain('ARN-TEST-123');
    expect(withoutArn.text).not.toContain('ARN:');
  });

  it.each([
    'Asia/Kolkata',
    'America/New_York',
  ])('formats appointment time using the supplied %s schedule timezone', (timezone) => {
    const rendered = renderEmailTemplate('appointment_rescheduled', { ...payload, timezone });
    const expectedTime = new Intl.DateTimeFormat('en-IN', {
      dateStyle: 'full',
      timeStyle: 'short',
      timeZone: timezone,
    }).format(new Date(payload.startsAt));
    expect(rendered.text).toContain(expectedTime);
    expect(rendered.text).toContain(`(${timezone})`);
  });

  it('does not invent a timezone when appointment timezone is unavailable', () => {
    const rendered = renderEmailTemplate('appointment_cancelled', { ...payload, timezone: undefined });
    expect(rendered.text).toContain('Please sign in to view your appointment details.');
  });
});
