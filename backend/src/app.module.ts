import 'dotenv/config';
import { Module } from '@nestjs/common';
import { createObserveModule } from '@nestjs/observe';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AuthModule } from './auth/auth.module.js';
import { AppointmentsModule } from './appointments/appointments.module.js';
import { DoctorsModule } from './doctors/doctors.module.js';
import { PatientsModule } from './patients/patients.module.js';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
  imports: [
    AuthModule,
    DoctorsModule,
    PatientsModule,
    AppointmentsModule,
    // Distributed tracing, auto-correlated logs, request/job metrics, error
    // telemetry, alarms, and more — out of the box. Sign up at https://observe.nestjs.com
    ObserveModule.forRoot({
      appKey: process.env.OBSERVE_APP_KEY ?? '',
      appSecret: process.env.OBSERVE_APP_SECRET ?? '',
      serviceId: 'backend',
    }),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
