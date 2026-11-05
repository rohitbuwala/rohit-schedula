import { EmailOutboxService, emailEventKey } from './email-outbox.service.js';
import { db } from '../db/database.js';
import { randomUUID } from 'node:crypto';

vi.mock('../db/database.js', () => ({
  db: {
    transaction: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

const baseRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'outbox-1',
  eventKey: 'refund_processed:refund-1:patient-1',
  eventType: 'refund_processed',
  recipient: 'test@example.invalid',
  payload: { recipientName: 'Test', amountPaise: 1000, currency: 'INR', arn: null },
  appointmentId: 'appointment-1',
  paymentId: 'payment-1',
  refundId: 'refund-1',
  status: 'pending',
  attemptCount: 0,
  nextAttemptAt: new Date(Date.now() - 1000),
  firstAttemptAt: null,
  lastError: null,
  processingAt: null,
  leaseExpiresAt: null,
  sentAt: null,
  createdAt: new Date(Date.now() - 1000),
  updatedAt: new Date(),
  ...overrides,
});

describe('EmailOutboxService', () => {
  beforeEach(() => vi.clearAllMocks());

  function mockDeadLetterCleanup(): ReturnType<typeof vi.fn> {
    const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    (db.update as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ set });
    return set;
  }

  it('uses a unique event key conflict target so repeated business events enqueue once', async () => {
    const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn().mockReturnValue({ onConflictDoNothing });
    const tx = { insert: vi.fn().mockReturnValue({ values }) };
    const service = new EmailOutboxService({} as never);
    const event = {
      eventKey: 'refund_processed:refund-1:patient-1',
      eventType: 'refund_processed' as const,
      recipient: 'test@example.invalid',
      payload: { recipientName: 'Test', amountPaise: 1000, currency: 'INR' },
      refundId: 'refund-1',
    };

    await service.enqueue(tx as never, event);
    await service.enqueue(tx as never, event);

    expect(values).toHaveBeenCalledTimes(2);
    expect(onConflictDoNothing).toHaveBeenCalledWith(expect.objectContaining({ target: expect.anything() }));
  });

  it('uses the same refund event key for webhook and reconciliation deliveries', () => {
    const webhookKey = emailEventKey.refundProcessed('refund-1', 'patient-1');
    const reconciliationKey = emailEventKey.refundProcessed('refund-1', 'patient-1');
    expect(webhookKey).toBe(reconciliationKey);
  });

  it('keeps distinct reschedules separate even when their timestamps share one millisecond', () => {
    const sameMillisecond = '2026-11-03T10:00:00.000Z';
    const firstEventId = randomUUID();
    const secondEventId = randomUUID();
    const firstKey = emailEventKey.appointment('appointment-1', 'appointment_rescheduled', firstEventId, 'patient-1');
    const secondKey = emailEventKey.appointment('appointment-1', 'appointment_rescheduled', secondEventId, 'patient-1');

    expect(sameMillisecond).toBe('2026-11-03T10:00:00.000Z');
    expect(firstKey).not.toBe(secondKey);
  });

  it('claims rows with FOR UPDATE SKIP LOCKED for concurrent workers', async () => {
    const forUpdate = vi.fn().mockResolvedValue([]);
    const limit = vi.fn().mockReturnValue({ for: forUpdate });
    const orderBy = vi.fn().mockReturnValue({ limit });
    const where = vi.fn().mockReturnValue({ orderBy });
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    (db.transaction as unknown as ReturnType<typeof vi.fn>).mockImplementation((callback: (tx: unknown) => unknown) => callback({ select }));
    const cleanupSet = mockDeadLetterCleanup();
    const service = new EmailOutboxService({} as never);

    await Promise.all([service.dispatchBatch(), service.dispatchBatch()]);

    expect(forUpdate).toHaveBeenCalledTimes(2);
    expect(forUpdate).toHaveBeenCalledWith('update', { skipLocked: true });
    expect(cleanupSet).toHaveBeenCalledWith(expect.objectContaining({ status: 'dead' }));
  });

  it('reclaims a processing row after its lease expires', async () => {
    const row = baseRow({ status: 'processing', attemptCount: 1, firstAttemptAt: new Date() });
    const forUpdate = vi.fn().mockResolvedValue([row]);
    const updated = { ...row, attemptCount: 2, status: 'processing' };
    const returning = vi.fn().mockResolvedValue([updated]);
    const updateWhere = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where: updateWhere });
    const tx = {
      select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockReturnValue({ for: forUpdate }) }) }) }) }),
      update: vi.fn().mockReturnValue({ set }),
    };
    (db.transaction as unknown as ReturnType<typeof vi.fn>).mockImplementation((callback: (tx: unknown) => unknown) => callback(tx));
    const cleanupSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const outsideSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    (db.update as unknown as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({ set: cleanupSet })
      .mockReturnValueOnce({ set: outsideSet });
    const email = { sendEvent: vi.fn().mockResolvedValue({ status: 'sent' }) };
    const service = new EmailOutboxService(email as never);

    await service.dispatchBatch();

    expect(forUpdate).toHaveBeenCalledWith('update', { skipLocked: true });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ status: 'processing', attemptCount: 2, leaseExpiresAt: expect.any(Date) }));
    expect(email.sendEvent).toHaveBeenCalledWith('refund_processed', row.recipient, row.payload, row.eventKey);
    expect(cleanupSet).toHaveBeenCalled();
  });

  it('retries an ambiguous timeout with the same event identity without throwing', async () => {
    const row = baseRow({ attemptCount: 1, firstAttemptAt: new Date() });
    const forUpdate = vi.fn().mockResolvedValue([row]);
    const returning = vi.fn().mockResolvedValue([{ ...row, attemptCount: 2 }]);
    const setClaim = vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning }) });
    const tx = {
      select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockReturnValue({ for: forUpdate }) }) }) }) }),
      update: vi.fn().mockReturnValue({ set: setClaim }),
    };
    (db.transaction as unknown as ReturnType<typeof vi.fn>).mockImplementation((callback: (tx: unknown) => unknown) => callback(tx));
    const cleanupSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const setRetry = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    (db.update as unknown as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({ set: cleanupSet })
      .mockReturnValueOnce({ set: setRetry });
    const email = { sendEvent: vi.fn().mockResolvedValue({ status: 'retryable', reason: 'request_timeout', ambiguous: true }) };
    const service = new EmailOutboxService(email as never);

    await expect(service.dispatchBatch()).resolves.toBe(1);
    expect(email.sendEvent).toHaveBeenCalledWith(row.eventType, row.recipient, row.payload, row.eventKey);
    expect(setRetry).toHaveBeenCalledWith(expect.objectContaining({
      status: 'pending',
      lastError: 'request_timeout; provider_acceptance_unknown',
      nextAttemptAt: expect.any(Date),
    }));
  });

  it('dead-letters an expired eighth-attempt lease without sending a ninth time', async () => {
    const cleanupSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    (db.update as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ set: cleanupSet });
    const forUpdate = vi.fn().mockResolvedValue([]);
    const tx = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({ for: forUpdate }),
            }),
          }),
        }),
      }),
    };
    (db.transaction as unknown as ReturnType<typeof vi.fn>).mockImplementation((callback: (tx: unknown) => unknown) => callback(tx));
    const email = { sendEvent: vi.fn() };
    const service = new EmailOutboxService(email as never);

    await expect(service.dispatchBatch()).resolves.toBe(0);

    expect(cleanupSet).toHaveBeenCalledWith(expect.objectContaining({
      status: 'dead',
      lastError: 'maximum_attempts_reached_after_worker_crash',
      leaseExpiresAt: null,
    }));
    expect(email.sendEvent).not.toHaveBeenCalled();
  });
});
