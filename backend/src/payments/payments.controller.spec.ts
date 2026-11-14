import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { PaymentsController } from './payments.controller.js';
import { RolesGuard } from '../auth/roles.guard.js';

describe('PaymentsController', () => {
  let controller: PaymentsController;
  let mockService: any;
  let rolesGuard: RolesGuard;

  beforeEach(() => {
    mockService = {
      createOrder: vi.fn(),
      verifyPayment: vi.fn(),
      handleWebhook: vi.fn(),
    };
    controller = new PaymentsController(mockService);
    rolesGuard = new RolesGuard(new Reflector());
  });

  describe('Authorization & Roles Guard', () => {
    it('blocks non-patient user from calling createOrder', () => {
      const context = {
        getHandler: () => PaymentsController.prototype.createOrder,
        getClass: () => PaymentsController,
        switchToHttp: () => ({
          getRequest: () => ({ authUser: { id: 'doc-1', role: 'doctor' } }),
        }),
      } as unknown as ExecutionContext;

      expect(() => rolesGuard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('blocks non-patient user from calling verifyPayment', () => {
      const context = {
        getHandler: () => PaymentsController.prototype.verifyPayment,
        getClass: () => PaymentsController,
        switchToHttp: () => ({
          getRequest: () => ({ authUser: { id: 'admin-1', role: 'admin' } }),
        }),
      } as unknown as ExecutionContext;

      expect(() => rolesGuard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('allows patient user to call createOrder and verifyPayment', () => {
      const context = {
        getHandler: () => PaymentsController.prototype.createOrder,
        getClass: () => PaymentsController,
        switchToHttp: () => ({
          getRequest: () => ({ authUser: { id: 'pat-1', role: 'patient' } }),
        }),
      } as unknown as ExecutionContext;

      expect(rolesGuard.canActivate(context)).toBe(true);
    });
  });

  describe('Validation & DTO parsing', () => {
    it('rejects invalid appointmentId format in createOrder', () => {
      expect(() =>
        controller.createOrder({ id: 'pat-1', role: 'patient' } as any, {
          appointmentId: 'not-a-uuid',
        }),
      ).toThrow(BadRequestException);
      expect(mockService.createOrder).not.toHaveBeenCalled();
    });

    it('forwards valid createOrder payload to service', async () => {
      const appointmentId = '00000000-0000-4000-8000-000000000001';
      mockService.createOrder.mockResolvedValueOnce({ orderId: 'order_123' });

      await controller.createOrder({ id: 'pat-1', role: 'patient' } as any, {
        appointmentId,
      });

      expect(mockService.createOrder).toHaveBeenCalledWith('pat-1', {
        appointmentId,
      });
    });

    it('rejects missing signature in verifyPayment payload', () => {
      const appointmentId = '00000000-0000-4000-8000-000000000001';
      expect(() =>
        controller.verifyPayment({ id: 'pat-1', role: 'patient' } as any, {
          appointmentId,
          razorpayOrderId: 'order_123',
          razorpayPaymentId: 'pay_123',
        }),
      ).toThrow(BadRequestException);
      expect(mockService.verifyPayment).not.toHaveBeenCalled();
    });

    it('forwards valid verifyPayment payload to service', async () => {
      const appointmentId = '00000000-0000-4000-8000-000000000001';
      mockService.verifyPayment.mockResolvedValueOnce({ success: true });

      await controller.verifyPayment({ id: 'pat-1', role: 'patient' } as any, {
        appointmentId,
        razorpayOrderId: 'order_123',
        razorpayPaymentId: 'pay_123',
        razorpaySignature: 'sig_123',
      });

      expect(mockService.verifyPayment).toHaveBeenCalledWith('pat-1', {
        appointmentId,
        razorpayOrderId: 'order_123',
        razorpayPaymentId: 'pay_123',
        razorpaySignature: 'sig_123',
      });
    });

    it('forwards webhook payload and signature with rawBody', async () => {
      mockService.handleWebhook.mockResolvedValueOnce({ received: true });
      const rawBuf = Buffer.from('{"event":"payment.captured"}');
      const req = { rawBody: rawBuf } as any;

      await controller.handleWebhook('sig_abc', req, { event: 'payment.captured' });

      expect(mockService.handleWebhook).toHaveBeenCalledWith('sig_abc', rawBuf, {
        event: 'payment.captured',
      });
    });

    it('rejects webhook if req.rawBody is missing', async () => {
      const req = {} as any;
      expect(() => controller.handleWebhook('sig_abc', req, { event: 'payment.captured' }))
        .toThrow(BadRequestException);
      expect(mockService.handleWebhook).not.toHaveBeenCalled();
    });
  });
});
