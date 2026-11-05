export type EmailEventType =
  | 'booking_confirmation'
  | 'payment_receipt'
  | 'appointment_cancelled'
  | 'appointment_rescheduled'
  | 'refund_processed'
  | 'appointment_reminder';

export interface EmailEventPayload {
  recipientName: string;
  otherPartyName?: string;
  startsAt?: string;
  timezone?: string;
  amountPaise?: number;
  currency?: string;
  arn?: string | null;
  intervalMinutes?: number;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character] ?? character);
}

function formatDate(payload: EmailEventPayload): string {
  if (!payload.startsAt || !payload.timezone) return 'Please sign in to view your appointment details.';
  const timezone = payload.timezone;
  return `${new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: timezone,
  }).format(new Date(payload.startsAt))} (${timezone})`;
}

function formatAmount(payload: EmailEventPayload): string {
  const amount = (payload.amountPaise ?? 0) / 100;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: payload.currency ?? 'INR',
  }).format(amount);
}

const copy: Record<EmailEventType, { subject: string; heading: string; body: (p: EmailEventPayload) => string }> = {
  booking_confirmation: {
    subject: 'Your Medrella Care appointment is confirmed',
    heading: 'Appointment confirmed',
    body: (p) => `Your appointment with ${p.otherPartyName ?? 'your doctor'} is confirmed.`,
  },
  payment_receipt: {
    subject: 'Your Medrella Care payment receipt',
    heading: 'Payment received',
    body: (p) => `We received your payment of ${formatAmount(p)} for your appointment with ${p.otherPartyName ?? 'your doctor'}.`,
  },
  appointment_cancelled: {
    subject: 'Your Medrella Care appointment was cancelled',
    heading: 'Appointment cancelled',
    body: (p) => `Your appointment with ${p.otherPartyName ?? 'the other participant'} was cancelled.`,
  },
  appointment_rescheduled: {
    subject: 'Your Medrella Care appointment was rescheduled',
    heading: 'Appointment rescheduled',
    body: (p) => `Your appointment with ${p.otherPartyName ?? 'the other participant'} has a new time.`,
  },
  refund_processed: {
    subject: 'Your Medrella Care refund has been processed',
    heading: 'Refund processed',
    body: (p) => `A refund of ${formatAmount(p)} has been processed.`,
  },
  appointment_reminder: {
    subject: 'Reminder: your Medrella Care appointment is coming up',
    heading: 'Upcoming appointment reminder',
    body: (p) => `This is a reminder of your appointment with ${p.otherPartyName ?? 'the other participant'}.`,
  },
};

export function renderEmailTemplate(type: EmailEventType, payload: EmailEventPayload): RenderedEmail {
  const event = copy[type];
  const name = escapeHtml(payload.recipientName);
  const safeBody = escapeHtml(event.body(payload));
  const date = escapeHtml(formatDate(payload));
  const amount = type === 'payment_receipt' || type === 'refund_processed'
    ? `<tr><td style="padding:8px 0;color:#475569">Amount</td><td style="padding:8px 0;text-align:right;font-weight:600">${escapeHtml(formatAmount(payload))}</td></tr>`
    : '';
  const arn = type === 'refund_processed' && payload.arn
    ? `<tr><td style="padding:8px 0;color:#475569">ARN</td><td style="padding:8px 0;text-align:right;font-weight:600">${escapeHtml(payload.arn)}</td></tr>`
    : '';
  const includeDate = type !== 'refund_processed';
  const textLines = [
    `Hello ${payload.recipientName},`,
    '',
    event.body(payload),
    ...(includeDate ? [`Appointment time: ${formatDate(payload)}`] : []),
    ...(type === 'refund_processed' && payload.arn ? [`ARN: ${payload.arn}`] : []),
    '',
    'Medrella Care',
  ];

  return {
    subject: event.subject,
    text: textLines.join('\n'),
    html: `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(event.subject)}</title>
<style>@media(max-width:600px){.container{width:100%!important;padding:20px!important}.content{padding:22px!important}}</style></head>
<body style="margin:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#0f172a">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f1f5f9;padding:28px 12px"><tr><td align="center">
<table role="presentation" class="container" width="600" cellspacing="0" cellpadding="0" style="width:600px;max-width:100%;background:#fff;border-radius:14px;overflow:hidden">
<tr><td style="background:#0f766e;padding:22px 30px;color:#fff;font-size:18px;font-weight:700">Medrella Care</td></tr>
<tr><td class="content" style="padding:32px"><h1 style="font-size:24px;line-height:1.3;margin:0 0 18px">${escapeHtml(event.heading)}</h1>
<p style="font-size:16px;line-height:1.6;margin:0 0 12px">Hello <strong>${name}</strong>,</p><p style="font-size:16px;line-height:1.6;margin:0 0 22px">${safeBody}</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f0fdfa;border:1px solid #ccfbf1;border-radius:10px;padding:14px 18px">
${includeDate ? `<tr><td style="padding:8px 0;color:#475569">Appointment</td><td style="padding:8px 0;text-align:right;font-weight:600">${date}</td></tr>` : ''}${amount}${arn}</table>
<p style="font-size:13px;line-height:1.5;color:#64748b;margin:24px 0 0">For questions, sign in to your Medrella Care account.</p></td></tr>
<tr><td style="padding:18px 30px;background:#f8fafc;color:#64748b;font-size:12px">This is an automated message from Medrella Care.</td></tr>
</table></td></tr></table></body></html>`,
  };
}
