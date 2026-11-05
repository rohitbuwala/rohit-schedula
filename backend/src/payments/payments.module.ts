import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AuthSessionGuard } from '../auth/auth-session.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { DoctorsModule } from '../doctors/doctors.module.js';
import { PaymentsController } from './payments.controller.js';
import { AdminPaymentsController } from './admin-payments.controller.js';
import { PaymentsService } from './payments.service.js';
import { PaymentReconciliationService } from './payment-reconciliation.service.js';
import { razorpayProvider } from './razorpay.provider.js';

@Module({
  imports: [AuthModule, NotificationsModule, DoctorsModule],
  controllers: [PaymentsController, AdminPaymentsController],
  providers: [
    AuthSessionGuard,
    RolesGuard,
    PaymentsService,
    PaymentReconciliationService,
    razorpayProvider,
  ],
  exports: [PaymentsService, PaymentReconciliationService],
})
export class PaymentsModule {}
