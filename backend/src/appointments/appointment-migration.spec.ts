import { readFileSync } from 'node:fs';

describe('appointment overlap migration preflight', () => {
  it('detects scheduled overlaps and fails before adding the constraint without modifying rows', () => {
    const migration = readFileSync(new URL('../../drizzle/0003_scheduled_appointment_overlap.sql', import.meta.url), 'utf8');
    const preflight = migration.indexOf('DO $$');
    const constraint = migration.indexOf('ALTER TABLE "appointment" ADD CONSTRAINT');

    expect(preflight).toBeGreaterThan(-1);
    expect(constraint).toBeGreaterThan(preflight);
    expect(migration).toContain("a.\"status\" = 'scheduled'");
    expect(migration).toContain("b.\"status\" = 'scheduled'");
    expect(migration).toContain("RAISE EXCEPTION 'Cannot add scheduled appointment overlap constraint:");
    expect(migration).not.toMatch(/\b(DELETE FROM|UPDATE\s+"?appointment"?|TRUNCATE)\b/i);
  });
});
