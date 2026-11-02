import test from "node:test";
import assert from "node:assert/strict";

// Utility helpers mirroring frontend component logic for unit testing

function calculateHoldSecondsRemaining(holdExpiresAt, nowMs = Date.now()) {
  const diffMs = new Date(holdExpiresAt).getTime() - nowMs;
  return Math.max(0, Math.floor(diffMs / 1000));
}

function formatCountdown(totalSec) {
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function buildVerifyPayload({ appointmentId, razorpayResponse }) {
  assert.ok(appointmentId, "appointmentId is required");
  assert.ok(razorpayResponse.razorpay_order_id, "razorpay_order_id is required");
  assert.ok(razorpayResponse.razorpay_payment_id, "razorpay_payment_id is required");
  assert.ok(razorpayResponse.razorpay_signature, "razorpay_signature is required");

  return {
    appointmentId,
    razorpayOrderId: razorpayResponse.razorpay_order_id,
    razorpayPaymentId: razorpayResponse.razorpay_payment_id,
    razorpaySignature: razorpayResponse.razorpay_signature,
  };
}

function determineAppointmentBadgeStatus(status, holdExpiresAt, nowMs = Date.now()) {
  if (status === "scheduled") return "scheduled";
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  if (status === "pending_payment") {
    if (!holdExpiresAt) return "hold_expired";
    const isExpired = new Date(holdExpiresAt).getTime() <= nowMs;
    return isExpired ? "hold_expired" : "pending_payment";
  }
  return "unknown";
}

test("Razorpay Checkout & Hold Expiry Logic", async (t) => {
  await t.test("calculates hold remaining seconds correctly for active hold", () => {
    const now = 1700000000000;
    const futureHold = new Date(now + 9 * 60 * 1000 + 45 * 1000).toISOString(); // 9m 45s future
    const remaining = calculateHoldSecondsRemaining(futureHold, now);
    assert.equal(remaining, 585);
    assert.equal(formatCountdown(remaining), "09:45");
  });

  await t.test("returns 0 and expires when holdExpiresAt has passed", () => {
    const now = 1700000000000;
    const pastHold = new Date(now - 1000).toISOString();
    const remaining = calculateHoldSecondsRemaining(pastHold, now);
    assert.equal(remaining, 0);
    assert.equal(formatCountdown(remaining), "00:00");
  });

  await t.test("formats edge countdown values accurately", () => {
    assert.equal(formatCountdown(600), "10:00");
    assert.equal(formatCountdown(60), "01:00");
    assert.equal(formatCountdown(9), "00:09");
    assert.equal(formatCountdown(0), "00:00");
  });

  await t.test("builds and validates cryptographic verify payload", () => {
    const payload = buildVerifyPayload({
      appointmentId: "11111111-1111-4111-8111-111111111111",
      razorpayResponse: {
        razorpay_order_id: "order_test_123",
        razorpay_payment_id: "pay_test_456",
        razorpay_signature: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      },
    });

    assert.deepEqual(payload, {
      appointmentId: "11111111-1111-4111-8111-111111111111",
      razorpayOrderId: "order_test_123",
      razorpayPaymentId: "pay_test_456",
      razorpaySignature: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    });
    // Asserts secret key is not in payload
    assert.equal(payload.keySecret, undefined);
  });

  await t.test("rejects missing fields in verify payload", () => {
    assert.throws(
      () =>
        buildVerifyPayload({
          appointmentId: "",
          razorpayResponse: {
            razorpay_order_id: "order_123",
            razorpay_payment_id: "pay_123",
            razorpay_signature: "sig_123",
          },
        }),
      /appointmentId is required/
    );
  });

  await t.test("determines appointment badge status dynamically based on holdExpiresAt", () => {
    const now = 1700000000000;
    const futureHold = new Date(now + 300000).toISOString();
    const pastHold = new Date(now - 1000).toISOString();

    assert.equal(determineAppointmentBadgeStatus("scheduled", null, now), "scheduled");
    assert.equal(determineAppointmentBadgeStatus("completed", null, now), "completed");
    assert.equal(determineAppointmentBadgeStatus("cancelled", null, now), "cancelled");
    assert.equal(determineAppointmentBadgeStatus("pending_payment", futureHold, now), "pending_payment");
    assert.equal(determineAppointmentBadgeStatus("pending_payment", pastHold, now), "hold_expired");
    assert.equal(determineAppointmentBadgeStatus("pending_payment", null, now), "hold_expired");
  });
});
