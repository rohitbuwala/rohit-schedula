import { ConflictException, ForbiddenException, InternalServerErrorException } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { readFileSync } from 'node:fs';
import { db } from '../db/database.js';
import { appointmentAttendance, doctorDailyQueue, schema } from '../db/schema.js';
import { allocateQueueToken, insertCheckIn, ownAttendanceRows, queueTransaction, readQueuePage, type QueueTransaction } from './appointment-queue-store.js';

vi.mock('../db/database.js', () => ({ db: { transaction: vi.fn() } }));

describe('queue SQL and database guarantees', () => {
  const mock = drizzle.mock({ schema });
  let results: unknown[][];
  let statements: { sql: string; params: unknown[] }[];
  // Build real Drizzle SQL but intercept execution. No connection or migration.
  function intercept<T extends { toSQL(): { sql: string; params: unknown[] } }>(query: T): T {
    Object.assign(query, { execute: async () => { statements.push(query.toSQL()); return results.shift() ?? []; } });
    return query;
  }
  const tx = {
    select: (fields?: Parameters<typeof mock.select>[0]) => ({ from: (table: never) => intercept(mock.select(fields as never).from(table)) }),
    insert: (table: never) => ({ values: (values: never) => intercept(mock.insert(table).values(values)) }),
    update: (table: never) => ({ set: (values: never) => intercept(mock.update(table).set(values)) }),
  } as unknown as QueueTransaction;
  beforeEach(() => { vi.clearAllMocks(); results = []; statements = []; });

  it('serializes allocation on the doctor/date row and atomically increments token and version', async () => {
    results.push([], [{ id: 'queue', timezone: 'UTC' }], [{ tokenNumber: 3, queueVersion: 3 }]);
    const result = await allocateQueueToken(tx, 'doctor', '2026-11-16', 'UTC', new Date('2026-11-16T10:00:00Z'));
    expect(result.tokenNumber).toBe(3);
    expect(statements[0].sql).toContain('on conflict ("doctor_id","service_date") do nothing');
    expect(statements[1].sql).toContain('for update');
    expect(statements[1].params).toContain('doctor'); expect(statements[1].params).toContain('2026-11-16');
    expect(statements[2].sql).toContain('"doctor_daily_queue"."next_token_number" + 1');
    expect(statements[2].sql).toContain('"doctor_daily_queue"."version" + 1');
    expect(statements[2].sql).not.toMatch(/max\(/i);
  });

  it('does not allocate from a queue whose timezone snapshot changed', async () => {
    results.push([], [{ id: 'queue', timezone: 'Asia/Kolkata' }]);
    await expect(allocateQueueToken(tx, 'doctor', '2026-11-16', 'UTC', new Date())).rejects.toBeInstanceOf(ConflictException);
    expect(statements).toHaveLength(2);
  });

  it('guards integer overflow instead of rolling or reusing tokens', async () => {
    results.push([], [{ id: 'queue', timezone: 'UTC' }], []);
    await expect(allocateQueueToken(tx, 'doctor', '2026-11-16', 'UTC', new Date())).rejects.toBeInstanceOf(ConflictException);
    expect(statements[2].params).toContain(2147483647);
  });

  it('writes attendance and check-in history on the same supplied transaction', async () => {
    await insertCheckIn(tx, { appointmentId: 'appointment', queueId: 'queue', doctorId: 'doctor', appointmentStartsAt: new Date(),
      status: 'waiting', tokenNumber: 1, checkedInAt: new Date(), checkedInBy: 'staff' }, 'staff', new Date());
    expect(statements[0].sql).toContain('insert into "appointment_attendance"');
    expect(statements[1].sql).toContain('insert into "appointment_history"');
    expect(statements[1].params).toContain('checked_in');
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('calculates positions before pagination with a stable tie-breaker and filters inactive bookings', async () => {
    results.push([], [{ count: 0 }], [], []);
    await readQueuePage(tx, 'doctor', 'queue', new Date('2026-11-16T00:00:00Z'), new Date('2026-11-17T00:00:00Z'), 10, 20);
    const sql = statements[0].sql;
    expect(sql).toContain('row_number() over (partition by');
    expect(sql).toContain('order by "appointment_attendance"."appointment_starts_at", "appointment_attendance"."checked_in_at", "appointment_attendance"."appointment_id"');
    expect(sql).toContain('"appointment"."starts_at" = "appointment_attendance"."appointment_starts_at"');
    expect(statements[0].params).toContain('scheduled'); expect(statements[0].params).toContain('waiting');
    expect(statements[0].params.slice(-2)).toEqual([11, 20]);
    expect(statements[3].sql).toContain('"appointment_attendance"."appointment_id" is null');
    expect(statements[3].params).toContain('doctor');
    expect(statements[4].params).toContain('queue');
    expect(statements[4].params).toContain('no_show');
    expect(statements[4].sql).toContain('"appointment_attendance"."queue_id"');
    for (const statement of statements) expect(statement.sql).not.toMatch(/insert into|update |delete from/i);
  });

  it('scopes patient lookups in SQL, including the ranked queue subset', async () => {
    await ownAttendanceRows(tx, 'patient-owner', ['appointment']);
    expect(statements).toHaveLength(1);
    expect(statements[0].sql).toContain('"appointment"."patient_id" =');
    expect(statements[0].params).toContain('patient-owner');
    expect(statements[0].sql).not.toMatch(/"email"|"phone"|"medications"|"payment"/);
  });

  it('defines unique attendance, daily tokens and a doctor-wide active consultation constraint', () => {
    const attendance = getTableConfig(appointmentAttendance), queue = getTableConfig(doctorDailyQueue);
    expect(attendance.columns.find(column => column.name === 'appointment_id')?.primary).toBe(true);
    expect(attendance.indexes.map(index => index.config.name)).toContain('appointment_attendance_queue_token_unique');
    const current = attendance.indexes.find(index => index.config.name === 'appointment_attendance_one_current_doctor_unique')!;
    expect(current.config.unique).toBe(true);
    expect(new PgDialect().sqlToQuery(current.config.where!).sql).toContain("= 'in_service'");
    expect(queue.indexes.map(index => index.config.name)).toContain('doctor_daily_queue_doctor_date_unique');
    expect(attendance.foreignKeys.map(key => key.getName())).toContain('appointment_attendance_queue_doctor_fk');
    const check = attendance.checks.find(item => item.name === 'appointment_attendance_check_in_check')!;
    expect(new PgDialect().sqlToQuery(check.value).sql).toContain('"token_number" is not null');
  });

  it('keeps migration and generated snapshot aligned without modifying booking/payment tables', () => {
    const migration = readFileSync(new URL('../../drizzle/0019_patient_queue.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const previous = JSON.parse(readFileSync(new URL('../../drizzle/meta/0018_snapshot.json', import.meta.url), 'utf8'));
    const current = JSON.parse(readFileSync(new URL('../../drizzle/meta/0019_snapshot.json', import.meta.url), 'utf8'));
    expect(current.prevId).toBe(previous.id);
    expect(migration.indexOf('CREATE UNIQUE INDEX "doctor_daily_queue_id_doctor_unique"'))
      .toBeLessThan(migration.indexOf('ADD CONSTRAINT "appointment_attendance_queue_doctor_fk"'));
    for (const [name, table] of Object.entries(previous.tables)) expect(current.tables[name]).toEqual(table);
    expect(migration).not.toMatch(/ALTER TABLE "(?:appointment|payment|refund)"|DROP |TRUNCATE |DELETE FROM /);
    for (const check of getTableConfig(appointmentAttendance).checks) {
      const sql = new PgDialect().sqlToQuery(check.value).sql.replace(/\r\n/g, '\n');
      expect(current.tables['public.appointment_attendance'].checkConstraints[check.name].value.replace(/\r\n/g, '\n')).toBe(sql);
      expect(migration).toContain(sql);
    }
  });
});

describe('queue transaction recovery', () => {
  beforeEach(() => vi.clearAllMocks());
  it('uses serializable writes and repeatable-read snapshots', async () => {
    const tx = {} as QueueTransaction;
    vi.mocked(db.transaction).mockImplementation(async callback => callback(tx));
    await expect(queueTransaction(async () => 'saved', true)).resolves.toBe('saved');
    expect(db.transaction).toHaveBeenLastCalledWith(expect.any(Function), { isolationLevel: 'serializable' });
    await queueTransaction(async () => 'snapshot');
    expect(db.transaction).toHaveBeenLastCalledWith(expect.any(Function), { isolationLevel: 'repeatable read' });
  });

  it('retries a whole transaction after serialization/deadlock failures with a bounded attempt count', async () => {
    const work = vi.fn().mockResolvedValue('saved');
    vi.mocked(db.transaction).mockRejectedValueOnce({ code: 'QUERY_FAILED', cause: { code: '40001' } })
      .mockRejectedValueOnce({ code: '40P01' }).mockImplementationOnce(async callback => callback({} as QueueTransaction));
    await expect(queueTransaction(work, true)).resolves.toBe('saved');
    expect(db.transaction).toHaveBeenCalledTimes(3);
    vi.mocked(db.transaction).mockReset().mockRejectedValue({ code: '40001', detail: 'private SQL' });
    await expect(queueTransaction(work, true)).rejects.toBeInstanceOf(ConflictException);
    expect(db.transaction).toHaveBeenCalledTimes(3);
  });

  it('does not retry authorization failures or leak SQL in errors', async () => {
    vi.mocked(db.transaction).mockRejectedValueOnce(new ForbiddenException());
    await expect(queueTransaction(async () => null)).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    vi.mocked(db.transaction).mockRejectedValueOnce(new Error('secret SQL'));
    await expect(queueTransaction(async () => null)).rejects.toBeInstanceOf(InternalServerErrorException);
  });
});
