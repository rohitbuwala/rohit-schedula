import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthSessionGuard } from '../auth/auth-session.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { PaymentsService } from './payments.service.js';
import {
  createPaymentOrderSchema,
  verifyPaymentSchema,
} from './payments.schema.js';

@Controller('api/payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('create-order')
  @UseGuards(AuthSessionGuard, RolesGuard)
  @Roles('patient')
  createOrder(@CurrentUser() patient: AuthenticatedUser, @Body() body: unknown) {
    const parsed = createPaymentOrderSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    return this.payments.createOrder(patient.id, parsed.data);
  }

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthSessionGuard, RolesGuard)
  @Roles('patient')
  verifyPayment(@CurrentUser() patient: AuthenticatedUser, @Body() body: unknown) {
    const parsed = verifyPaymentSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    return this.payments.verifyPayment(patient.id, parsed.data);
  }

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  handleWebhook(
    @Headers('x-razorpay-signature') signature: string | undefined,
    @Req() req: Request & { rawBody?: Buffer },
    @Body() body: unknown,
  ) {
    const rawBody = req.rawBody ?? JSON.stringify(body);
    return this.payments.handleWebhook(signature, rawBody, body);
  }
}
