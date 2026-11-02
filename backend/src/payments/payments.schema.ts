import { z } from 'zod';

export const createPaymentOrderSchema = z
  .object({
    appointmentId: z.string().uuid('Invalid appointment ID format.'),
  })
  .strict();

export const verifyPaymentSchema = z
  .object({
    appointmentId: z.string().uuid('Invalid appointment ID format.'),
    razorpayOrderId: z.string().trim().min(1, 'razorpayOrderId is required.'),
    razorpayPaymentId: z.string().trim().min(1, 'razorpayPaymentId is required.'),
    razorpaySignature: z.string().trim().min(1, 'razorpaySignature is required.'),
  })
  .strict();

export const createRefundSchema = z
  .object({
    reason: z.string().trim().min(3, 'Refund reason must be at least 3 characters.'),
    amountPaise: z.number().int().positive('Refund amount must be a positive integer in paise.').optional(),
    notes: z.string().trim().max(500, 'Notes must not exceed 500 characters.').optional(),
  })
  .strict();

export const adminListPaymentsQuerySchema = z.object({
  status: z.enum(['created', 'captured', 'failed', 'refunded']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const adminListRefundsQuerySchema = z.object({
  status: z.enum(['pending', 'processed', 'failed']).optional(),
  paymentId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type CreatePaymentOrderDto = z.infer<typeof createPaymentOrderSchema>;
export type VerifyPaymentDto = z.infer<typeof verifyPaymentSchema>;
export type CreateRefundDto = z.infer<typeof createRefundSchema>;
export type AdminListPaymentsQueryDto = z.infer<typeof adminListPaymentsQuerySchema>;
export type AdminListRefundsQueryDto = z.infer<typeof adminListRefundsQuerySchema>;
