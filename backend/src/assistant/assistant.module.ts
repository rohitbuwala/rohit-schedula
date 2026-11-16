import { Module } from '@nestjs/common';
import { AppointmentsModule } from '../appointments/appointments.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AuthSessionGuard } from '../auth/auth-session.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { DoctorsModule } from '../doctors/doctors.module.js';
import { AssistantController } from './assistant.controller.js';
import { ASSISTANT_PROVIDER } from './assistant-provider.js';
import { AssistantToolsService } from './assistant-tools.service.js';
import { AssistantService } from './assistant.service.js';
import { GeminiProvider } from './gemini.provider.js';
import { AssistantVoiceController } from './assistant-voice.controller.js';
import { AssistantVoiceService } from './assistant-voice.service.js';
import { AssistantTtsService } from './assistant-tts.service.js';

@Module({
  imports: [AuthModule, AppointmentsModule, DoctorsModule],
  controllers: [AssistantController, AssistantVoiceController],
  providers: [
    AuthSessionGuard,
    RolesGuard,
    AssistantService,
    AssistantVoiceService,
    AssistantTtsService,
    AssistantToolsService,
    { provide: ASSISTANT_PROVIDER, useClass: GeminiProvider },
  ],
})
export class AssistantModule {}
