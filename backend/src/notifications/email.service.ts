import { Injectable, Logger } from '@nestjs/common';
import type { EmailEventPayload, EmailEventType } from './email-templates.js';
import { renderEmailTemplate } from './email-templates.js';

export type EmailSendResult =
  | { status: 'sent' }
  | { status: 'disabled' }
  | { status: 'retryable'; reason: string; ambiguous: boolean }
  | { status: 'permanent_failure'; reason: string };

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private warnedDisabled = false;

  private getDeliverySettings(): { apiKey: string; from: string; mode: 'test' | 'production'; testRecipient?: string } | null {
    // Never permit automated test processes to reach Resend, even if they inherit deployment credentials.
    if (process.env.NODE_ENV === 'test') return null;
    const mode = process.env.EMAIL_DELIVERY_MODE ?? 'disabled';
    if (mode !== 'test' && mode !== 'production') return null;
    if (mode === 'production' && process.env.NODE_ENV !== 'production') return null;
    if (mode === 'test' && process.env.NODE_ENV === 'production') return null;

    const apiKey = process.env.RESEND_API_KEY?.trim();
    const from = process.env.EMAIL_FROM?.trim();
    const testRecipient = process.env.EMAIL_TEST_RECIPIENT?.trim();
    if (!apiKey || !from || (mode === 'test' && !testRecipient)) return null;
    return { apiKey, from, mode, testRecipient };
  }

  isConfigured(): boolean {
    return this.getDeliverySettings() !== null;
  }

  isTestMode(): boolean {
    return this.getDeliverySettings()?.mode === 'test';
  }

  async sendEvent(
    type: EmailEventType,
    recipient: string,
    payload: EmailEventPayload,
    idempotencyKey: string,
  ): Promise<EmailSendResult> {
    const settings = this.getDeliverySettings();
    if (type === 'appointment_reminder' && settings?.mode !== 'test') {
      return { status: 'disabled' };
    }
    if (!settings) {
      if (!this.warnedDisabled) {
        this.logger.warn('Email delivery disabled: check EMAIL_DELIVERY_MODE, Resend credentials, and test recipient configuration.');
        this.warnedDisabled = true;
      }
      return { status: 'disabled' };
    }

    let message;
    try {
      message = renderEmailTemplate(type, payload);
    } catch {
      this.logger.error('Email template rendering failed; the event will not be sent.');
      return { status: 'permanent_failure', reason: 'template_render_failure' };
    }
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${settings.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          from: settings.from,
          to: [settings.mode === 'test' ? settings.testRecipient! : recipient],
          subject: message.subject,
          html: message.html,
          text: message.text,
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (response.ok) return { status: 'sent' };
      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        this.logger.warn(`Resend temporarily rejected an email (HTTP ${response.status}).`);
        return { status: 'retryable', reason: `http_${response.status}`, ambiguous: false };
      }
      this.logger.warn(`Resend permanently rejected an email (HTTP ${response.status}).`);
      return { status: 'permanent_failure', reason: `http_${response.status}` };
    } catch (error: unknown) {
      // A network timeout does not establish whether Resend accepted the request.
      // The outbox retries with this same idempotency key and an unchanged payload.
      const isTimeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      this.logger.warn(`Resend request ${isTimeout ? 'timed out' : 'failed before a response was received'}; delivery outcome may be unknown.`);
      return { status: 'retryable', reason: isTimeout ? 'request_timeout' : 'network_error', ambiguous: true };
    }
  }
}
