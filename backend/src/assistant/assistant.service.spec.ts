import { ForbiddenException, InternalServerErrorException, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { AssistantService } from './assistant.service.js';
import { AssistantToolsService } from './assistant-tools.service.js';

vi.mock('../db/database.js', () => ({ db: {} }));

const patient: AuthenticatedUser = { role: 'patient', id: 'p1', name: 'Patient', email: 'p@example.test' };
const doctor: AuthenticatedUser = { ...patient, role: 'doctor', id: 'd1' };
const id = '00000000-0000-4000-8000-000000000001';

describe('assistant orchestration and read tools', () => {
  const selectTool = vi.fn();
  const listMineReadOnly = vi.fn();
  const listPatientPrescriptions = vi.fn();
  const listPatientPaymentHistory = vi.fn();
  const cancel = vi.fn();
  const getMineReadOnly = vi.fn();
  const getAvailableSlots = vi.fn();
  const findNextDoctorSlot = vi.fn();
  const suggestDoctorRescheduleSlots = vi.fn();
  const listPublicProfiles = vi.fn();
  const isApproved = vi.fn();
  const getApplicationForApplicant = vi.fn();
  const getSchedule = vi.fn();
  const countDoctorAppointmentsByStatus = vi.fn();
  const checkTimeRangeConflicts = vi.fn();
  const appointments = { listMineReadOnly, listPatientPrescriptions, listPatientPaymentHistory, getMineReadOnly, getAvailableSlots, countDoctorAppointmentsByStatus, findNextDoctorSlot, suggestDoctorRescheduleSlots, cancel };
  const profiles = { listPublicProfiles, isApproved, getApplicationForApplicant };
  const tools = new AssistantToolsService(appointments as never, profiles as never, { getSchedule, checkTimeRangeConflicts } as never);
  let assistant: AssistantService;

  beforeEach(() => {
    vi.resetAllMocks();
    assistant = new AssistantService({ selectTool }, tools, profiles as never);
    isApproved.mockResolvedValue(true);
    getApplicationForApplicant.mockResolvedValue(null);
    listPublicProfiles.mockResolvedValue([]);
    listMineReadOnly.mockResolvedValue([]);
    getSchedule.mockResolvedValue({
      timezone: 'Asia/Kolkata', activeDays: [1], startHour: 9, endHour: 17,
      slotDurationMinutes: 30, breakStart: null, breakEnd: null,
      leaves: [{ date: '2026-11-12', reason: 'private reason' }],
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('answers booking lookups without relying on the AI provider', async () => {
    selectTool.mockRejectedValue(new ServiceUnavailableException('Provider unavailable'));
    await expect(assistant.chat(patient, 'find my booking')).resolves.toMatchObject({ tool: 'list_appointments' });
    await expect(assistant.chat(patient, 'show my upcoming bookings')).resolves.toMatchObject({ tool: 'list_appointments', data: { filter: 'upcoming' } });
    expect(selectTool).not.toHaveBeenCalled();
    expect(listMineReadOnly).toHaveBeenCalledWith(patient, { filter: 'upcoming' });
    await expect(assistant.chat(patient, 'cancel my booking')).resolves.toMatchObject({ tool: 'clarify' });
    expect(cancel).not.toHaveBeenCalled();
  });

  it('checks current doctor approval before sending anything to the provider', async () => {
    isApproved.mockResolvedValue(false);
    await expect(assistant.chat(doctor, 'My schedule')).rejects.toBeInstanceOf(ForbiddenException);
    expect(isApproved).toHaveBeenCalledWith(doctor.id);
    expect(selectTool).not.toHaveBeenCalled();
  });

  it('starts a patient booking draft without allowing other write requests', async () => {
    await expect(assistant.chat(patient, 'Book an appointment')).resolves.toMatchObject({ tool: 'start_booking' });
    await expect(assistant.chat(patient, 'Book an appointment and cancel my appointment')).resolves.toMatchObject({ tool: 'clarify' });
    await expect(assistant.chat(doctor, 'Book an appointment')).resolves.toMatchObject({ tool: 'clarify' });
    expect(selectTool).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('extracts natural language booking details for a patient', async () => {
    const mockDoctor = { id: '00000000-0000-4000-8000-000000000099', name: 'Dr. Anita Sharma', specialty: 'Cardiology' };
    listPublicProfiles.mockResolvedValue([mockDoctor]);

    const result1 = await assistant.chat(patient, 'Book tomorrow at 10 AM with Dr Sharma');
    expect(result1).toMatchObject({
      tool: 'start_booking',
      data: {
        doctorProfileId: mockDoctor.id,
        doctorName: mockDoctor.name,
        time: '10:00',
      },
    });

    const result2 = await assistant.chat(patient, 'I want to see Dr Sharma tomorrow');
    expect(result2).toMatchObject({
      tool: 'start_booking',
      data: {
        doctorProfileId: mockDoctor.id,
        doctorName: mockDoctor.name,
      },
    });

    const result3 = await assistant.chat(patient, 'Schedule an appointment for next Monday');
    expect(result3).toMatchObject({
      tool: 'start_booking',
      data: {},
    });
    expect((result3 as { data: { date?: string } }).data.date).toBeDefined();

    const result4 = await assistant.chat(patient, 'Book a cardiologist for tomorrow morning');
    expect(result4).toMatchObject({
      tool: 'start_booking',
      data: {
        specialty: 'Cardiology',
        doctorProfileId: mockDoctor.id,
      },
    });
  });

  it('blocks a pending doctor applicant even when their session still has the patient role', async () => {
    getApplicationForApplicant.mockResolvedValue({ status: 'pending' });
    await expect(assistant.chat(patient, 'Show my appointments')).rejects.toBeInstanceOf(ForbiddenException);
    expect(selectTool).not.toHaveBeenCalled();
    expect(listMineReadOnly).not.toHaveBeenCalled();
  });

  it('rechecks for pending applications before returning patient data', async () => {
    getApplicationForApplicant.mockResolvedValueOnce(null).mockResolvedValueOnce({ status: 'pending' });
    selectTool.mockResolvedValue({ name: 'list_appointments' });
    await expect(assistant.chat(patient, 'Show my appointments')).rejects.toBeInstanceOf(ForbiddenException);
    expect(listMineReadOnly).not.toHaveBeenCalled();
  });

  it.each(['today_appointments', 'doctor_appointments_by_date', 'appointment_details', 'view_schedule', 'appointment_statistics', 'schedule_conflicts', 'next_available_slot', 'reschedule_suggestions'])(
    'denies %s when approval is revoked during provider selection', async (name) => {
      selectTool.mockImplementationOnce(async () => {
        isApproved.mockResolvedValue(false);
        return { name };
      });
      await expect(assistant.chat(doctor, `Show my schedule and appointment details ${id}`))
        .rejects.toBeInstanceOf(ForbiddenException);
      expect(isApproved).toHaveBeenNthCalledWith(2, doctor.id);
      expect(getSchedule).not.toHaveBeenCalled();
      expect(listMineReadOnly).not.toHaveBeenCalled();
      expect(getMineReadOnly).not.toHaveBeenCalled();
      expect(countDoctorAppointmentsByStatus).not.toHaveBeenCalled();
      expect(checkTimeRangeConflicts).not.toHaveBeenCalled();
      expect(findNextDoctorSlot).not.toHaveBeenCalled();
      expect(suggestDoctorRescheduleSlots).not.toHaveBeenCalled();
    },
  );

  it('validates a selected appointment locally and keeps direct rescheduling blocked', async () => {
    selectTool.mockResolvedValue({ name: 'reschedule_suggestions' });
    suggestDoctorRescheduleSlots.mockResolvedValue({ timezone: 'UTC', slots: [] });
    await expect(assistant.chat(doctor, `Reschedule appointment ${id}`)).resolves.toMatchObject({ tool: 'clarify' });
    expect(selectTool).not.toHaveBeenCalled();
    await expect(assistant.chat(doctor, 'Suggest alternative slots')).resolves.toMatchObject({ tool: 'clarify' });
    expect(suggestDoctorRescheduleSlots).not.toHaveBeenCalled();
    await expect(assistant.chat(doctor, `Show reschedule suggestions for appointment ${id}`))
      .resolves.toMatchObject({ tool: 'reschedule_suggestions', data: { slots: [] } });
    expect(suggestDoctorRescheduleSlots).toHaveBeenCalledWith(doctor, id);
    expect(selectTool.mock.lastCall?.[0]).not.toContain(id);
  });

  it('defaults the horizon and accepts a bounded override without sending it to Gemini', async () => {
    selectTool.mockResolvedValue({ name: 'next_available_slot' });
    findNextDoctorSlot.mockResolvedValue({ timezone: 'Asia/Kolkata', slot: null });
    await expect(assistant.chat(doctor, 'Find my next available slot')).resolves.toMatchObject({ data: { horizonDays: 30 } });
    await expect(assistant.chat(doctor, `Find my next available slot within 7 days for ${id}`))
      .resolves.toMatchObject({ data: { horizonDays: 7 } });
    expect(findNextDoctorSlot.mock.calls).toEqual([[doctor, 30], [doctor, 7]]);
    expect(selectTool.mock.lastCall?.[0]).not.toMatch(/7|00000000/);
  });

  it.each(['0 days', '91 days', '-3 days', '2.5 days', '1,001 days', '2 days or 3 days'])('clarifies an invalid horizon of %s', async (horizon) => {
    selectTool.mockResolvedValue({ name: 'next_available_slot' });
    await expect(assistant.chat(doctor, `Find my next available slot within ${horizon}`)).resolves.toMatchObject({ tool: 'clarify' });
    expect(findNextDoctorSlot).not.toHaveBeenCalled();
  });

  it('uses the doctor timezone for today and keeps dates out of Gemini input', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-12T01:00:00Z'));
    getSchedule.mockResolvedValue({ timezone: 'America/New_York' });
    selectTool.mockResolvedValue({ name: 'appointment_statistics' });
    countDoctorAppointmentsByStatus.mockResolvedValue({
      total: 53, byStatus: { scheduled: 50, cancelled: 1, completed: 1, pending_payment: 1 },
    });
    await expect(assistant.chat(doctor, 'Appointment statistics for today')).resolves.toMatchObject({
      data: { date: '2026-11-11', timezone: 'America/New_York', total: 53 },
    });
    await assistant.chat(doctor, 'Appointment statistics for 2026-11-20');
    expect(countDoctorAppointmentsByStatus).toHaveBeenLastCalledWith(doctor, { date: '2026-11-20', timezone: 'America/New_York' });
    expect(selectTool.mock.lastCall?.[0]).toBe('appointment statistics date provided');
  });

  it.each([
    ['today', '2026-11-30', 'doctor_appointments_by_date'],
    ['tomorrow', '2026-12-01', 'doctor_appointments_by_date'],
    ['2027-01-04', '2027-01-04', 'doctor_appointments_by_date'],
    ['tomorrow', '2026-12-01', 'today_appointments'],
  ])('lists the authenticated doctor’s appointments for %s with %s as the local date (%s)', async (input, date, name) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-12-01T01:00:00Z'));
    getSchedule.mockResolvedValue({ timezone: 'America/New_York' });
    selectTool.mockResolvedValue({ name });
    const entry = { startsAt: new Date(), endsAt: new Date(Date.now() + 30 * 60_000), status: 'scheduled' };
    listMineReadOnly.mockResolvedValue([{ ...entry, id, patientId: 'private' }]);
    const result = await assistant.chat(doctor, `Show appointments for ${input}`);
    expect(result.tool).toBe('doctor_appointments_by_date');
    expect(result.data).toEqual({ date, timezone: 'America/New_York', appointments: [entry], hasMore: false });
    expect(listMineReadOnly).toHaveBeenCalledWith(doctor, { date, timezone: 'America/New_York' });
    expect(selectTool.mock.lastCall?.[0]).not.toContain('2027-01-04');
  });

  it.each(['2026-02-30', '0000-01-01', 'today or tomorrow', 'today or 2026-11-12', 'next week'])(
    'clarifies %s before querying appointments', async (input) => {
      selectTool.mockResolvedValue({ name: 'doctor_appointments_by_date' });
      await expect(assistant.chat(doctor, `Show appointments for ${input}`)).resolves.toMatchObject({ tool: 'clarify' });
      expect(listMineReadOnly).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['appointment_statistics', 'Appointment statistics for 2026-02-30'],
    ['appointment_statistics', 'Appointment statistics for tomorrow'],
    ['appointment_statistics', 'Appointment statistics for 2026-11-12 and 2026-11-13'],
    ['schedule_conflicts', 'Check conflicts from 2026-11-12T10:00 to 2026-11-12T11:00'],
    ['schedule_conflicts', 'Check conflicts from 2026-11-12T11:00Z to 2026-11-12T10:00Z'],
    ['schedule_conflicts', 'Check conflicts from 2026-11-12T11:00Z to 2026-11-20T11:00Z'],
  ])('clarifies invalid %s input without querying the data', async (name, message) => {
    selectTool.mockResolvedValue({ name });
    await expect(assistant.chat(doctor, message)).resolves.toMatchObject({ tool: 'clarify', data: null });
    expect(countDoctorAppointmentsByStatus).not.toHaveBeenCalled();
    expect(checkTimeRangeConflicts).not.toHaveBeenCalled();
  });

  it('resolves conflict inputs locally and uses the session doctor identity', async () => {
    const startsAt = new Date('2026-11-12T04:30Z');
    const endsAt = new Date('2026-11-12T05:30Z');
    selectTool.mockResolvedValue({ name: 'schedule_conflicts' });
    checkTimeRangeConflicts.mockResolvedValue({ conflicts: [{ id, startsAt, endsAt }], hasMore: false });
    await expect(assistant.chat(doctor, `Check conflicts from 2026-11-12T10:00+05:30 to 2026-11-12T11:00+05:30 for ${id}`))
      .resolves.toMatchObject({ data: { startsAt, endsAt, conflicts: [{ id, startsAt, endsAt }] } });
    expect(checkTimeRangeConflicts).toHaveBeenCalledWith(doctor.id, { startsAt, endsAt });
    expect(selectTool.mock.lastCall?.[0]).toBe('conflicts appointment reference provided');
  });

  it('limits Gemini calls per user in a rolling minute and ignores local clarifications', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-11-11T20:00:00Z').getTime();
    vi.setSystemTime(now);
    selectTool.mockResolvedValue({ name: 'clarify' });
    await assistant.chat(patient, 'Cancel my appointment');
    for (let request = 0; request < 10; request++) {
      await assistant.chat(patient, 'Show my appointments');
    }
    vi.setSystemTime(now + 59_999);
    await expect(assistant.chat(patient, 'Show my appointments')).rejects.toMatchObject({ status: 429 });
    expect(selectTool).toHaveBeenCalledTimes(10);
    await assistant.chat({ ...patient, id: 'p2' }, 'Show my appointments');
    vi.setSystemTime(now + 60_000);
    await assistant.chat(patient, 'Show my appointments');
    expect(selectTool).toHaveBeenCalledTimes(12);
  });

  it('rejects overlapping calls for one user and releases the slot on provider failure', async () => {
    const pending = Promise.withResolvers<unknown>();
    selectTool.mockReturnValueOnce(pending.promise).mockResolvedValue({ name: 'clarify' });
    const first = assistant.chat(patient, 'Show my appointments');
    const firstResult = expect(first).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(assistant.chat(patient, 'Show my appointments')).rejects.toMatchObject({ status: 429 });
    expect(selectTool).toHaveBeenCalledTimes(1);
    await assistant.chat({ ...patient, id: 'p2' }, 'Show my appointments');
    pending.reject(new ServiceUnavailableException());
    await firstResult;
    await assistant.chat(patient, 'Show my appointments');
    expect(selectTool).toHaveBeenCalledTimes(3);
  });

  it('logs only a fixed message when a database error contains private parameters', async () => {
    const logger = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    selectTool.mockResolvedValue({ name: 'list_appointments' });
    listMineReadOnly.mockRejectedValue(new Error('Failed query: params: private-patient-id', {
      cause: new Error('private-session-token'),
    }));
    const error = await assistant.chat(patient, 'Show my appointments').catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(InternalServerErrorException);
    expect(error).toMatchObject({ message: 'Assistant request failed.', cause: undefined });
    expect(logger.mock.calls).toEqual([['Assistant request failed.']]);
  });

  it('bounds provider concurrency across accounts and recovers capacity after a rejection', async () => {
    const pending = Promise.withResolvers<{ name: string }>();
    const rejected = Promise.withResolvers<never>();
    selectTool.mockReturnValueOnce(rejected.promise).mockReturnValue(pending.promise);
    const requests = Array.from({ length: 8 }, (_, index) =>
      assistant.chat({ ...patient, id: `account-${index}` }, 'Show my appointments'));
    const failure = expect(requests[0]).rejects.toBeInstanceOf(ServiceUnavailableException);
    const extra = { ...patient, id: 'extra-account' };
    await expect(assistant.chat(extra, 'Show my appointments')).rejects.toMatchObject({
      message: 'Assistant is busy. Try again shortly.',
    });
    expect(selectTool).toHaveBeenCalledTimes(8);
    rejected.reject(new ServiceUnavailableException());
    await failure;
    pending.resolve({ name: 'clarify' });
    await expect(assistant.chat(extra, 'Show my appointments')).resolves.toMatchObject({ tool: 'clarify' });
    await Promise.all(requests.slice(1));
  });

  it('lists the verified patient’s appointments and only sends fixed intent keywords', async () => {
    selectTool.mockResolvedValue({ name: 'list_appointments', args: {} });
    const result = await assistant.chat(patient, `My appointments for Jane Doe j@example.test ${id} 2026-11-12`);
    expect(selectTool).toHaveBeenCalledWith('my appointments', expect.objectContaining({ list_appointments: expect.any(String) }));
    expect(selectTool.mock.calls[0][1]).not.toHaveProperty('appointment_details');
    expect(listMineReadOnly).toHaveBeenCalledWith(patient, { filter: 'all' });
    expect(result.data).toEqual({ filter: 'all', appointments: [], hasMore: false });
  });

  it.each([
    ['Show upcoming appointments', 'upcoming'],
    ['Show previous appointments', 'past'],
    ['Show all appointments', 'all'],
    ['Show past and upcoming appointments', 'all'],
  ])('applies the requested filter for %s and preserves the result cap', async (message, filter) => {
    selectTool.mockResolvedValue({ name: 'list_appointments' });
    listMineReadOnly.mockResolvedValue(Array.from({ length: 51 }, () => ({ period: 'upcoming' })));
    const result = await assistant.chat(patient, `${message} for ${id}`);
    expect(listMineReadOnly).toHaveBeenCalledWith(patient, { filter });
    expect(result.data).toMatchObject({ filter, hasMore: true });
    expect(result.data).toHaveProperty('appointments.length', 50);
  });

  it('filters the real public profile list by name or specialty', async () => {
    selectTool.mockResolvedValue({ name: 'search_doctors' });
    listPublicProfiles.mockResolvedValue([
      { id, name: 'Asha Shah', specialty: 'Cardiology', consultationFeeInr: 500, bio: 'Extra data' },
      { id: 'other', name: 'Other Doctor', specialty: 'Neurology' },
    ]);
    const result = await assistant.chat(patient, 'Find doctors in cardiology');
    expect(result.data).toEqual({ doctors: [{ id, name: 'Asha Shah', specialty: 'Cardiology', consultationFeeInr: 500 }], hasMore: false });
  });

  it('suggests the three closest same-day slots when the requested time is unavailable', async () => {
    selectTool.mockResolvedValue({ name: 'check_availability' });
    listPublicProfiles.mockResolvedValue([{ id, name: 'Asha Shah', specialty: 'Cardiology' }]);
    const slots = ['04:00', '04:30', '05:30', '06:00'].map((time) => ({
      startsAt: `2026-11-12T${time}:00.000Z`, endsAt: '2026-11-12T06:30:00.000Z',
    }));
    getAvailableSlots.mockResolvedValue({ doctorProfileId: id, date: '2026-11-12', timezone: 'Asia/Kolkata', durationMinutes: 30, slots });
    const result = await assistant.chat(patient, 'Check availability with Dr Asha Shah on 2026-11-12 at 10:30');
    expect(result).toMatchObject({ tool: 'alternative_slots', data: { slots: [slots[1], slots[2], slots[0]] } });
    expect(getAvailableSlots).toHaveBeenCalledWith(patient.id, { doctorProfileId: id, date: '2026-11-12' });
    expect(selectTool.mock.lastCall?.[0]).not.toMatch(/Asha|10:30|2026/i);
  });

  it('returns the requested slot when open and no suggestions when the date is full', async () => {
    selectTool.mockResolvedValue({ name: 'alternative_slots' });
    const slot = { startsAt: '2026-11-12T05:00:00.000Z', endsAt: '2026-11-12T05:30:00.000Z' };
    const data = { doctorProfileId: id, date: '2026-11-12', timezone: 'Asia/Kolkata', durationMinutes: 30 };
    getAvailableSlots.mockResolvedValueOnce({ ...data, slots: [slot] }).mockResolvedValueOnce({ ...data, slots: [] });
    const prompt = `Suggest alternative slots for ${id} on 2026-11-12 at 10:30`;
    await expect(assistant.chat(patient, prompt)).resolves.toMatchObject({ tool: 'check_availability', data: { slots: [slot] } });
    await expect(assistant.chat(patient, prompt)).resolves.toMatchObject({ tool: 'alternative_slots', data: { slots: [] } });
  });

  it.each(['', 'at 25:00', 'at 09:30 pm', 'at 09:30 and 10:00'])('clarifies an invalid alternative slot time %s', async (time) => {
    selectTool.mockResolvedValue({ name: 'alternative_slots' });
    await expect(assistant.chat(patient, `Suggest alternative slots for ${id} on 2026-11-12 ${time}`))
      .resolves.toMatchObject({ tool: 'clarify' });
    expect(getAvailableSlots).not.toHaveBeenCalled();
  });

  it('validates the date and profile reference locally before querying availability', async () => {
    selectTool.mockResolvedValue({ name: 'check_availability' });
    getAvailableSlots.mockResolvedValue({ slots: [] });
    await expect(assistant.chat(patient, `Check availability ${id} on 2026-02-30`)).resolves.toMatchObject({ tool: 'clarify' });
    expect(getAvailableSlots).not.toHaveBeenCalled();
    await assistant.chat(patient, `Check availability ${id} on 2026-11-12`);
    expect(getAvailableSlots).toHaveBeenCalledWith(patient.id, { doctorProfileId: id, date: '2026-11-12' });
  });

  it('uses the doctor’s local day when it differs from UTC', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-11T20:00:00Z'));
    selectTool.mockResolvedValue({ name: 'today_appointments' });
    await assistant.chat(doctor, 'Show appointments today');
    expect(listMineReadOnly).toHaveBeenCalledWith(doctor, {
      date: '2026-11-12', timezone: expect.stringMatching(/^Asia\/(Kolkata|Calcutta)$/),
    });
  });

  it('passes the authenticated doctor and locally validated appointment ID for details', async () => {
    selectTool.mockResolvedValue({ name: 'appointment_details' });
    await assistant.chat(doctor, `Show appointment details ${id}`);
    expect(getMineReadOnly).toHaveBeenCalledWith(id, doctor);
  });

  it('returns the same configured timezone and unchanged UTC instants for doctor lists and details', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-12T03:00:00Z'));
    const record = { id, startsAt: new Date('2026-11-12T03:00:00Z'), endsAt: new Date('2026-11-12T03:30:00Z'), status: 'scheduled' };
    getSchedule.mockResolvedValue({ timezone: 'America/New_York' });
    listMineReadOnly.mockResolvedValue([record]);
    getMineReadOnly.mockResolvedValue(record);
    selectTool.mockResolvedValueOnce({ name: 'today_appointments' }).mockResolvedValueOnce({ name: 'appointment_details' });
    const list = await assistant.chat(doctor, 'Show appointments today');
    const details = await assistant.chat(doctor, `Show appointment details ${id}`);
    expect(list.data).toMatchObject({ timezone: 'America/New_York', date: '2026-11-11', appointments: [record] });
    expect(details.data).toEqual({ ...record, timezone: 'America/New_York' });
    expect(listMineReadOnly).toHaveBeenCalledWith(doctor, { timezone: 'America/New_York', date: '2026-11-11' });
  });

  it('omits leave reasons from the schedule reply', async () => {
    selectTool.mockResolvedValue({ name: 'view_schedule' });
    const result = await assistant.chat(doctor, 'Show my schedule and leave');
    expect(result.data).toMatchObject({ leaveDates: ['2026-11-12'] });
    expect(JSON.stringify(result)).not.toContain('private reason');
  });

  it('handles write requests without selecting a tool', async () => {
    await expect(assistant.chat(patient, 'Cancel my appointment')).resolves.toMatchObject({ tool: 'clarify' });
    expect(selectTool).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('loads cancellable appointments for the session patient without calling Gemini', async () => {
    await expect(assistant.chat(patient, 'Show cancellable appointments')).resolves.toMatchObject({
      tool: 'list_appointments', data: { filter: 'cancellable' },
    });
    expect(listMineReadOnly).toHaveBeenCalledWith(patient, { filter: 'cancellable' });
    expect(selectTool).not.toHaveBeenCalled();
  });

  it('reads prescriptions for the verified patient without sending medical data to Gemini', async () => {
    listPatientPrescriptions.mockResolvedValue({ prescriptions: [], hasMore: false });
    await expect(assistant.chat(patient, `Show prescriptions for ${id}`)).resolves.toMatchObject({
      tool: 'list_prescriptions', data: { prescriptions: [] },
    });
    expect(listPatientPrescriptions).toHaveBeenCalledWith(patient);
    await expect(assistant.chat(doctor, 'Prescriptions')).resolves.toMatchObject({ tool: 'clarify' });
    expect(listPatientPrescriptions).toHaveBeenCalledOnce();
    expect(selectTool).not.toHaveBeenCalled();
  });

  it('handles patient payment and refund history locally without permitting refund actions', async () => {
    listPatientPaymentHistory.mockResolvedValue({ payments: [], hasMore: false });
    await expect(assistant.chat(patient, 'Show my payment history')).resolves.toMatchObject({ tool: 'payment_history' });
    await expect(assistant.chat(patient, 'Show my refund status')).resolves.toMatchObject({ tool: 'payment_history' });
    await expect(assistant.chat(patient, 'Refund my payment')).resolves.toMatchObject({ tool: 'clarify' });
    await expect(assistant.chat(doctor, 'My payment history')).resolves.toMatchObject({ tool: 'clarify' });
    expect(listPatientPaymentHistory.mock.calls).toEqual([[patient], [patient]]);
    expect(selectTool).not.toHaveBeenCalled();
  });

  it('uses the existing cancellation service and rejects doctors and pending applicants', async () => {
    await expect(assistant.cancelAppointment(doctor, id, 'other')).rejects.toBeInstanceOf(ForbiddenException);
    getApplicationForApplicant.mockResolvedValueOnce({ status: 'pending' });
    await expect(assistant.cancelAppointment(patient, id, 'other')).rejects.toBeInstanceOf(ForbiddenException);
    expect(cancel).not.toHaveBeenCalled();
    await expect(assistant.cancelAppointment(patient, id, 'schedule_conflict')).resolves.toEqual({ status: 'cancelled' });
    expect(cancel).toHaveBeenCalledWith(id, patient, 'Appointment cancelled by patient: Schedule conflict');
    expect(selectTool).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'cancel_appointment' },
    { name: 'appointment_details' },
    { name: 'doctor_appointments_by_date' },
    { name: 'appointment_statistics' },
    { name: 'schedule_conflicts' },
    { name: 'next_available_slot' },
    { name: 'reschedule_suggestions' },
    { name: 'list_appointments', args: { patientId: 'other' } },
    { name: 'constructor' },
    null,
  ])('fails closed on invalid or unauthorized tool selections', async (selection) => {
    selectTool.mockResolvedValue(selection);
    await expect(assistant.chat(patient, 'Show my appointments')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(listMineReadOnly).not.toHaveBeenCalled();
    expect(getMineReadOnly).not.toHaveBeenCalled();
    expect(countDoctorAppointmentsByStatus).not.toHaveBeenCalled();
    expect(checkTimeRangeConflicts).not.toHaveBeenCalled();
    expect(findNextDoctorSlot).not.toHaveBeenCalled();
    expect(suggestDoctorRescheduleSlots).not.toHaveBeenCalled();
  });
});
