import { getTableConfig } from 'drizzle-orm/pg-core';
import { readFileSync } from 'node:fs';
import { doctorScheduleOverride } from './schema.js';

function readJson(path: string): any {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
}

describe('doctor schedule override schema', () => {
  it('declares the date format constraint from migration 0013', () => {
    const checks = getTableConfig(doctorScheduleOverride).checks;

    expect(checks.map((constraint) => constraint.name)).toContain(
      'doctor_schedule_override_date_check',
    );
  });

  it('keeps migration 0013/0014 snapshots linked and aligned with their schema changes', () => {
    const prior = readJson('../../drizzle/meta/0012_snapshot.json');
    const overrides = readJson('../../drizzle/meta/0013_snapshot.json');
    const capacity = readJson('../../drizzle/meta/0014_snapshot.json');
    const journal = readJson('../../drizzle/meta/_journal.json');

    expect(overrides.prevId).toBe(prior.id);
    expect(capacity.prevId).toBe(overrides.id);
    expect(overrides.tables['public.doctor_schedule_override'].checkConstraints)
      .toHaveProperty('doctor_schedule_override_date_check');
    expect(capacity.tables['public.doctor_availability'].columns)
      .toHaveProperty('scheduling_mode');
    expect(capacity.tables['public.doctor_availability'].columns)
      .toHaveProperty('capacity');
    expect(capacity.tables['public.doctor_schedule_override'].columns)
      .toHaveProperty('capacity');
    expect(journal.entries.slice(13, 15).map((entry: { tag: string }) => entry.tag)).toEqual([
      '0013_doctor_schedule_overrides',
      '0014_wave_stream_capacity',
    ]);
  });
});
