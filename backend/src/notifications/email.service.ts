import { Injectable, Logger } from '@nestjs/common';

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  async sendEmail(options: SendEmailOptions): Promise<boolean> {
    const apiKey = process.env.RESEND_API_KEY;
    const fromAddress = process.env.EMAIL_FROM ?? 'Medrella Care <notifications@medrella.local>';

    if (!apiKey) {
      this.logger.log(
        `[EmailService: Dev Simulation] Email to: ${options.to} | Subject: "${options.subject}"`
      );
      return true;
    }

    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: fromAddress,
          to: [options.to],
          subject: options.subject,
          html: options.html,
          text: options.text,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.warn(`Resend email delivery failed (${response.status}): ${errorText}`);
        return false;
      }

      this.logger.log(`Email successfully delivered to ${options.to}`);
      return true;
    } catch (err: unknown) {
      this.logger.warn(
        `Failed to send email to ${options.to}: ${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    }
  }

  async sendAppointmentBookedEmail(params: {
    to: string;
    patientName: string;
    doctorName: string;
    startsAt: Date;
    timezone?: string;
  }) {
    const timeFormatted = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'full',
      timeStyle: 'short',
      timeZone: params.timezone ?? 'UTC',
    }).format(params.startsAt);

    return this.sendEmail({
      to: params.to,
      subject: `Confirmed: Consultation with Dr. ${params.doctorName}`,
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; color: #1e293b;">
          <h2 style="color: #0f766e;">Medrella Healthcare Confirmation</h2>
          <p>Hello <strong>${params.patientName}</strong>,</p>
          <p>Your appointment has been confirmed with <strong>Dr. ${params.doctorName}</strong>.</p>
          <div style="background-color: #f0fdfa; border: 1px solid #ccfbf1; padding: 16px; border-radius: 8px;">
            <p style="margin: 0;"><strong>Date & Time:</strong> ${timeFormatted} (${params.timezone ?? 'UTC'})</p>
            <p style="margin: 8px 0 0 0;"><strong>Status:</strong> Scheduled</p>
          </div>
          <p style="font-size: 13px; color: #64748b; margin-top: 24px;">Need to reschedule or cancel? Log in to your Medrella Patient Portal.</p>
        </div>
      `,
    });
  }

  async sendAppointmentRescheduledEmail(params: {
    to: string;
    recipientName: string;
    otherPartyName: string;
    startsAt: Date;
    timezone?: string;
  }) {
    const timeFormatted = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'full',
      timeStyle: 'short',
      timeZone: params.timezone ?? 'UTC',
    }).format(params.startsAt);

    return this.sendEmail({
      to: params.to,
      subject: `Rescheduled: Consultation with ${params.otherPartyName}`,
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; color: #1e293b;">
          <h2 style="color: #0f766e;">Medrella Schedule Update</h2>
          <p>Hello <strong>${params.recipientName}</strong>,</p>
          <p>Your consultation with <strong>${params.otherPartyName}</strong> has been rescheduled.</p>
          <div style="background-color: #f0fdfa; border: 1px solid #ccfbf1; padding: 16px; border-radius: 8px;">
            <p style="margin: 0;"><strong>New Consultation Time:</strong> ${timeFormatted} (${params.timezone ?? 'UTC'})</p>
          </div>
        </div>
      `,
    });
  }

  async sendAppointmentCancelledEmail(params: {
    to: string;
    recipientName: string;
    otherPartyName: string;
    startsAt: Date;
    timezone?: string;
  }) {
    const timeFormatted = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'full',
      timeStyle: 'short',
      timeZone: params.timezone ?? 'UTC',
    }).format(params.startsAt);

    return this.sendEmail({
      to: params.to,
      subject: `Cancelled: Consultation with ${params.otherPartyName}`,
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; color: #1e293b;">
          <h2 style="color: #dc2626;">Medrella Cancellation Notice</h2>
          <p>Hello <strong>${params.recipientName}</strong>,</p>
          <p>Your appointment with <strong>${params.otherPartyName}</strong> previously set for <strong>${timeFormatted}</strong> has been cancelled.</p>
          <p>The time slot has been released. You may book another consultation window at any time through the Medrella portal.</p>
        </div>
      `,
    });
  }
}
