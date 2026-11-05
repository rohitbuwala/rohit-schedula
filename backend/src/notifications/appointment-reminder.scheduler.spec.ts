import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { AppointmentReminderService } from './appointment-reminder.service.js';
import { EmailService } from './email.service.js';

@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [
    AppointmentReminderService,
    {
      provide: EmailService,
      useValue: { isTestMode: vi.fn().mockReturnValue(false) },
    },
  ],
})
class ReminderSchedulerTestModule {}

describe('AppointmentReminderService scheduler lifecycle', () => {
  it('registers the dispatch and retention intervals on startup and clears them on shutdown', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ReminderSchedulerTestModule],
    }).compile();

    const registry = moduleRef.get(SchedulerRegistry);
    await moduleRef.init();

    expect(registry.getIntervals()).toHaveLength(2);

    await moduleRef.close();

    expect(registry.getIntervals()).toEqual([]);
  });
});
