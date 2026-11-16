import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  groupSlotsByPeriod,
  getStatusBadgeConfig,
  getPaymentStatusBadgeConfig,
  formatSlotTime,
  formatSlotRange,
  slotDurationLabel,
  appointmentTimeRange,
  formatCurrencyInr,
  getRelativeDateStr,
} from "../components/assistant/assistant-ui-helpers.ts";

it("shows actual 15 and 30 minute slot ranges in the doctor's timezone", () => {
  const start = "2026-11-15T04:30:00Z";
  const shortEnd = "2026-11-15T04:45:00Z";
  const longEnd = "2026-11-15T05:00:00Z";
  assert.equal(formatSlotRange(start, shortEnd, "IST"), `${formatSlotTime(start, "Asia/Kolkata")} – ${formatSlotTime(shortEnd, "Asia/Kolkata")}`);
  assert.match(formatSlotRange(start, shortEnd, "IST"), /10:00.*10:15/);
  assert.match(formatSlotRange(start, longEnd, "IST"), /10:00.*10:30/);
  assert.equal(slotDurationLabel(start, shortEnd), "15 min");
  assert.equal(slotDurationLabel(start, longEnd), "30 min");
});
import { parseSafeInline, SafeMarkdown } from "../components/assistant/safe-markdown.ts";

describe("Assistant UI Logic & Helpers", () => {
  describe("groupSlotsByPeriod", () => {
    it("groups slots into Morning, Afternoon, and Evening correctly for Asia/Kolkata", () => {
      // 09:00 IST is 03:30 UTC
      // 14:00 IST is 08:30 UTC
      // 18:00 IST is 12:30 UTC
      const slots = [
        { startsAt: "2026-11-15T03:30:00.000Z", endsAt: "2026-11-15T04:00:00.000Z" }, // 09:00 IST (Morning)
        { startsAt: "2026-11-15T04:30:00.000Z", endsAt: "2026-11-15T05:00:00.000Z" }, // 10:00 IST (Morning)
        { startsAt: "2026-11-15T08:30:00.000Z", endsAt: "2026-11-15T09:00:00.000Z" }, // 14:00 IST (Afternoon)
        { startsAt: "2026-11-15T12:30:00.000Z", endsAt: "2026-11-15T13:00:00.000Z" }, // 18:00 IST (Evening)
      ];

      const groups = groupSlotsByPeriod(slots, "Asia/Kolkata");
      assert.equal(groups.length, 3);
      assert.equal(groups[0].label, "Morning");
      assert.equal(groups[0].slots.length, 2);
      assert.equal(groups[1].label, "Afternoon");
      assert.equal(groups[1].slots.length, 1);
      assert.equal(groups[2].label, "Evening");
      assert.equal(groups[2].slots.length, 1);
    });

    it("handles slots when only one period is populated", () => {
      const slots = [
        { startsAt: "2026-11-15T03:30:00.000Z", endsAt: "2026-11-15T04:00:00.000Z" },
      ];
      const groups = groupSlotsByPeriod(slots, "Asia/Kolkata");
      assert.equal(groups.length, 1);
      assert.equal(groups[0].label, "Morning");
    });

    it("handles empty slots gracefully", () => {
      const groups = groupSlotsByPeriod([], "Asia/Kolkata");
      assert.deepEqual(groups, []);
    });
  });

  describe("Time and Currency Formatters", () => {
    it("formats slot time in Asia/Kolkata", () => {
      const formatted = formatSlotTime("2026-11-15T04:30:00.000Z", "Asia/Kolkata");
      assert.match(formatted, /10:00\s*(?:am|AM)/i);
    });

    it("formats appointment time range in Asia/Kolkata", () => {
      const range = appointmentTimeRange("2026-11-15T04:30:00.000Z", "2026-11-15T05:00:00.000Z", "Asia/Kolkata");
      assert.match(range, /10:00/);
      assert.match(range, /10:30/);
    });

    it("formats Indian Rupee currency with symbol", () => {
      assert.equal(formatCurrencyInr(500), "₹500");
      assert.equal(formatCurrencyInr(1250), "₹1,250");
    });

    it("computes relative date strings correctly for Today and Tomorrow in Asia/Kolkata", () => {
      const today = getRelativeDateStr(0, "Asia/Kolkata");
      const tomorrow = getRelativeDateStr(1, "Asia/Kolkata");
      assert.match(today, /^\d{4}-\d{2}-\d{2}$/);
      assert.match(tomorrow, /^\d{4}-\d{2}-\d{2}$/);
      assert.notEqual(today, tomorrow);
    });
  });

  describe("StatusBadges Config", () => {
    it("returns proper styling and labels for appointment statuses", () => {
      const scheduled = getStatusBadgeConfig("scheduled");
      assert.equal(scheduled.label, "Scheduled");
      assert.match(scheduled.className, /bg-emerald-50/);

      const pending = getStatusBadgeConfig("pending_payment");
      assert.equal(pending.label, "Pending payment");
      assert.match(pending.className, /bg-amber-50/);

      const cancelled = getStatusBadgeConfig("cancelled");
      assert.equal(cancelled.label, "Cancelled");
      assert.match(cancelled.className, /bg-rose-50/);

      const completed = getStatusBadgeConfig("completed");
      assert.equal(completed.label, "Completed");
      assert.match(completed.className, /bg-blue-50/);
    });

    it("returns proper styling and labels for payment statuses", () => {
      const captured = getPaymentStatusBadgeConfig("captured");
      assert.equal(captured.label, "Paid");
      assert.match(captured.className, /bg-emerald-50/);

      const refunded = getPaymentStatusBadgeConfig("refunded");
      assert.equal(refunded.label, "Refunded");
      assert.match(refunded.className, /bg-blue-50/);

      const failed = getPaymentStatusBadgeConfig("failed");
      assert.equal(failed.label, "Failed");
      assert.match(failed.className, /bg-rose-50/);

      const created = getPaymentStatusBadgeConfig("created");
      assert.equal(created.label, "Pending payment");
      assert.match(created.className, /bg-amber-50/);
    });
  });

  describe("SafeMarkdown & XSS Security", () => {
    it("formats bold, italic, and inline code without HTML execution", () => {
      const parts = parseSafeInline("**Appointment confirmed** for *tomorrow* at `10:30 AM`");
      assert.equal(parts.length, 5);
      assert.equal(parts[0].type, "strong");
      assert.equal(parts[0].props.children[0], "Appointment confirmed");
      assert.equal(parts[1], " for ");
      assert.equal(parts[2].type, "em");
      assert.equal(parts[2].props.children[0], "tomorrow");
      assert.equal(parts[3], " at ");
      assert.equal(parts[4].type, "code");
      assert.equal(parts[4].props.children, "10:30 AM");
    });

    it("prevents script execution and treats HTML markup as inert text", () => {
      const raw = '<script>window.location="http://attacker.com"</script>';
      const parts = parseSafeInline(raw);
      assert.equal(parts.length, 1);
      assert.equal(parts[0], raw);
    });

    it("renders bullet lists cleanly with nested formatting", () => {
      const text = "- **Dr. Sharma**: 10:00 AM\n- *Dr. Patel*: 11:30 AM";
      const result = SafeMarkdown({ content: text });
      assert.equal(result.type, "div");
      const ul = result.props.children[0];
      assert.equal(ul.type, "ul");
      assert.equal(ul.props.children.length, 2);
      assert.equal(ul.props.children[0].type, "li");
      assert.equal(ul.props.children[1].type, "li");
    });
  });
});
