import { BadRequestException, Body, Controller, Header, HttpCode, Post, StreamableFile, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { z } from 'zod';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthSessionGuard } from '../auth/auth-session.guard.js';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { AssistantVoiceService, MAX_WAV_BYTES } from './assistant-voice.service.js';
import { AssistantTtsService } from './assistant-tts.service.js';

@Controller('api/assistant/voice')
@UseGuards(AuthSessionGuard, RolesGuard)
@Roles('patient', 'doctor')
export class AssistantVoiceController {
  constructor(private readonly voice: AssistantVoiceService, private readonly tts: AssistantTtsService) {}

  @Post('synthesize')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'audio/wav')
  async synthesize(@CurrentUser() actor: AuthenticatedUser, @Body() body: unknown) {
    const parsed = z.strictObject({ text: z.string().trim().min(1).max(2500), language: z.enum(['en', 'hi']) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException('Provide valid text and voice language.');
    return new StreamableFile(await this.tts.synthesize(actor, parsed.data.text, parsed.data.language));
  }

  @Post('transcribe')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_WAV_BYTES, files: 1, fields: 0, parts: 1 } }))
  transcribe(@CurrentUser() actor: AuthenticatedUser, @UploadedFile() file?: { mimetype: string; buffer: Buffer }) {
    return this.voice.transcribe(actor, file);
  }
}
