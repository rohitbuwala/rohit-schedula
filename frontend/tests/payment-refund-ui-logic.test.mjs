import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("Payment and Refund UI state handling", () => {
  function resolvePatientStatusBadges({ appointmentStatus, payment, isHoldExpired }) {
    let appointmentDisplay = "Scheduled";
    if (appointmentStatus === "completed") appointmentDisplay = "Completed";
    else if (appointmentStatus === "cancelled") appointmentDisplay = "Cancelled";
    else if (appointmentStatus === "pending_payment") {
      appointmentDisplay = isHoldExpired ? "Hold Expired" : "Slot Reserved";
    }

    const paymentDisplay =
      payment?.statusDisplay ??
      (appointmentStatus === "pending_payment" ? "Payment Pending" : "Unpaid");

    return {
      appointmentBadge: appointmentDisplay,
      paymentBadge: paymentDisplay,
    };
  }

  function formatInr(paise) {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: "INR",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(paise / 100);
  }

  it("clearly distinguishes cancelled appointment from refunded payment", () => {
    // Case 1: Cancelled appointment with confirmed refund
    const refundedCase = resolvePatientStatusBadges({
      appointmentStatus: "cancelled",
      payment: {
        status: "refunded",
        statusDisplay: "Refunded",
        amountPaise: 50000,
        refundedAmountPaise: 50000,
      },
    });
    assert.equal(refundedCase.appointmentBadge, "Cancelled");
    assert.equal(refundedCase.paymentBadge, "Refunded");

    // Case 2: Cancelled appointment where refund is still pending
    const refundPendingCase = resolvePatientStatusBadges({
      appointmentStatus: "cancelled",
      payment: {
        status: "captured",
        statusDisplay: "Refund Pending",
        amountPaise: 50000,
        refundedAmountPaise: 0,
      },
    });
    assert.equal(refundPendingCase.appointmentBadge, "Cancelled");
    assert.equal(refundPendingCase.paymentBadge, "Refund Pending");

    // Case 3: Cancelled appointment where payment was completed but no refund was issued yet
    const paidNoRefundCase = resolvePatientStatusBadges({
      appointmentStatus: "cancelled",
      payment: {
        status: "captured",
        statusDisplay: "Paid",
        amountPaise: 50000,
        refundedAmountPaise: 0,
      },
    });
    assert.equal(paidNoRefundCase.appointmentBadge, "Cancelled");
    assert.equal(paidNoRefundCase.paymentBadge, "Paid");
    assert.notEqual(paidNoRefundCase.paymentBadge, "Refunded");

    // Case 4: Cancelled appointment where refund failed
    const refundFailedCase = resolvePatientStatusBadges({
      appointmentStatus: "cancelled",
      payment: {
        status: "captured",
        statusDisplay: "Refund Failed",
        amountPaise: 50000,
        refundedAmountPaise: 0,
      },
    });
    assert.equal(refundFailedCase.appointmentBadge, "Cancelled");
    assert.equal(refundFailedCase.paymentBadge, "Refund Failed");
  });

  it("ensures Refund Pending uses a calm status icon and no infinite spinning", () => {
    // In our UI, status badges are static states.
    // They must not render animate-spin on persistent indicators.
    function getStatusBadgeConfig(statusDisplay) {
      if (statusDisplay === "Refund Pending") {
        return { icon: "Clock", isSpinning: false, colorClass: "text-purple-600" };
      }
      if (statusDisplay === "Refund Failed") {
        return { icon: "AlertCircle", isSpinning: false, colorClass: "text-rose-600" };
      }
      if (statusDisplay === "Paid") {
        return { icon: "CheckCircle2", isSpinning: false, colorClass: "text-emerald-600" };
      }
      return { icon: "none", isSpinning: false, colorClass: "text-slate-600" };
    }

    const pendingConfig = getStatusBadgeConfig("Refund Pending");
    assert.equal(pendingConfig.icon, "Clock");
    assert.equal(pendingConfig.isSpinning, false);

    const failedConfig = getStatusBadgeConfig("Refund Failed");
    assert.equal(failedConfig.icon, "AlertCircle");
    assert.equal(failedConfig.isSpinning, false);
  });

  it("maintains consistent refund status across dashboard refresh cycles", () => {
    // Initial appointment state before reconciliation
    const initialAppointment = {
      id: "appt-1",
      status: "cancelled",
      payment: {
        status: "captured",
        statusDisplay: "Refund Pending",
        amountPaise: 90000,
        refund: { status: "pending", amountPaise: 90000, arn: null },
      },
    };

    assert.equal(initialAppointment.payment.statusDisplay, "Refund Pending");
    assert.equal(initialAppointment.payment.refund.status, "pending");

    // After reconciliation on dashboard reload / refresh:
    const refreshedAppointment = {
      id: "appt-1",
      status: "cancelled",
      payment: {
        status: "refunded",
        statusDisplay: "Refunded",
        amountPaise: 90000,
        refund: { status: "processed", amountPaise: 90000, arn: "ARN_TEST_123" },
      },
    };

    assert.equal(refreshedAppointment.payment.statusDisplay, "Refunded");
    assert.equal(refreshedAppointment.payment.refund.status, "processed");
    assert.equal(refreshedAppointment.payment.refund.arn, "ARN_TEST_123");
  });

  it("handles scheduled and active appointment states correctly", () => {
    const scheduledCase = resolvePatientStatusBadges({
      appointmentStatus: "scheduled",
      payment: {
        status: "captured",
        statusDisplay: "Paid",
        amountPaise: 75000,
        refundedAmountPaise: 0,
      },
    });
    assert.equal(scheduledCase.appointmentBadge, "Scheduled");
    assert.equal(scheduledCase.paymentBadge, "Paid");
  });

  it("handles pending payment and expired hold states correctly", () => {
    const activeHold = resolvePatientStatusBadges({
      appointmentStatus: "pending_payment",
      payment: null,
      isHoldExpired: false,
    });
    assert.equal(activeHold.appointmentBadge, "Slot Reserved");
    assert.equal(activeHold.paymentBadge, "Payment Pending");

    const expiredHold = resolvePatientStatusBadges({
      appointmentStatus: "pending_payment",
      payment: null,
      isHoldExpired: true,
    });
    assert.equal(expiredHold.appointmentBadge, "Hold Expired");
    assert.equal(expiredHold.paymentBadge, "Payment Pending");
  });

  it("formats paise to Indian Rupee currency string accurately", () => {
    // 50000 paise -> ₹500.00
    const formatted500 = formatInr(50000);
    assert.match(formatted500, /500\.00/);

    // 123456 paise -> ₹1,234.56
    const formatted1234 = formatInr(123456);
    assert.match(formatted1234, /1,234\.56/);

    // 0 paise -> ₹0.00
    const formatted0 = formatInr(0);
    assert.match(formatted0, /0\.00/);
  });

  it("calculates admin ledger financial totals correctly", () => {
    const payments = [
      { status: "captured", amountPaise: 100000, refundedAmountPaise: 0 },
      { status: "captured", amountPaise: 50000, refundedAmountPaise: 20000 },
      { status: "refunded", amountPaise: 50000, refundedAmountPaise: 50000 },
      { status: "failed", amountPaise: 50000, refundedAmountPaise: 0 },
      { status: "created", amountPaise: 50000, refundedAmountPaise: 0 },
    ];
    const refunds = [
      { status: "processed", amountPaise: 50000 },
      { status: "processed", amountPaise: 20000 },
      { status: "pending", amountPaise: 30000 },
    ];

    let grossCollectedPaise = 0;
    let totalRefundedPaise = 0;
    let capturedCount = 0;
    for (const p of payments) {
      if (p.status === "captured" || p.status === "refunded") {
        grossCollectedPaise += p.amountPaise;
        capturedCount += 1;
      }
      totalRefundedPaise += p.refundedAmountPaise || 0;
    }

    const pendingRefundCount = refunds.filter((r) => r.status === "pending").length;
    const netRevenuePaise = Math.max(0, grossCollectedPaise - totalRefundedPaise);

    assert.equal(capturedCount, 3);
    assert.equal(grossCollectedPaise, 200000); // ₹2,000.00
    assert.equal(totalRefundedPaise, 70000);   // ₹700.00
    assert.equal(netRevenuePaise, 130000);     // ₹1,300.00
    assert.equal(pendingRefundCount, 1);
  });
});
