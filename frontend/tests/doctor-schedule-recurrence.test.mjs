import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const component = await readFile(
  new URL("../components/doctor-schedule-manager.tsx", import.meta.url),
  "utf8",
);

describe("doctor schedule recurrence controls", () => {
  it("exposes accessible recurring and non-recurring choices", () => {
    assert.match(component, /aria-label="Recurring or non-recurring availability"/);
    assert.match(component, />Recurring · weekly<\/button>/);
    assert.match(component, />Non-recurring · one date<\/button>/);
    assert.match(component, /aria-pressed=\{scheduleType === "recurring"\}/);
    assert.match(component, /aria-pressed=\{scheduleType === "single"\}/);
  });

  it("routes weekly and one-date choices to their existing save forms", () => {
    assert.match(component, /scheduleType === "recurring" \? "" : "hidden"/);
    assert.match(component, /scheduleType === "single" \? "" : "hidden"/);
    assert.match(component, /fetch\(`\$\{backendUrl\}\/api\/doctor\/schedule`/);
    assert.match(component, /fetch\(`\$\{backendUrl\}\/api\/doctor\/schedule\/override`/);
  });
});
