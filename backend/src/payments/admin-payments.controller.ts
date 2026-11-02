import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthSessionGuard } from '../auth/auth-session.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { PaymentsService } from './payments.service.js';
import { PaymentReconciliationService } from './payment-reconciliation.service.js';
import {
  adminListPaymentsQuerySchema,
  adminListRefundsQuerySchema,
  createRefundSchema,
} from './payments.schema.js';

@Controller('api/admin')
@UseGuards(AuthSessionGuard, RolesGuard)
@Roles('admin')
export class AdminPaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly reconciliation: PaymentReconciliationService,
  ) {}

  @Get('payments')
  async listPayments(@Query() query: unknown) {
    const parsed = adminListPaymentsQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    return this.payments.adminListPayments(parsed.data);
  }

  @Get('payments/:id')
  async getPaymentDetails(@Param('id') id: string) {
    return this.payments.adminGetPaymentDetails(id);
  }

  @Post('payments/:id/refund')
  @HttpCode(HttpStatus.OK)
  async refundPayment(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const parsed = createRefundSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    return this.payments.refundPayment(admin.id, admin.role, id, parsed.data);
  }

  @Get('refunds')
  async listRefunds(@Query() query: unknown) {
    const parsed = adminListRefundsQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    return this.payments.adminListRefunds(parsed.data);
  }

  @Post('reconcile')
  @HttpCode(HttpStatus.OK)
  async triggerReconciliation() {
    const count = await this.reconciliation.reconcileInconsistentPayments();
    return {
      success: true,
      reconciledCount: count,
      message: `Reconciliation completed. ${count} item(s) reconciled.`,
    };
  }
}
