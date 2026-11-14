import type { LaunchCheckoutParams } from "../../lib/razorpay.ts";
import type { RazorpayResponse } from "../../types/razorpay.ts";

export async function payForAssistantHold(
  appointmentId: string,
  patientId: string,
  checkout: (options: LaunchCheckoutParams) => Promise<RazorpayResponse>,
  request: typeof fetch = fetch,
  onStage: (stage: "opening" | "verifying") => void = () => {},
) {
  const session = await request("/api/auth/get-session", { credentials: "include", cache: "no-store" });
  if (!session.ok || (await session.json())?.user?.id !== patientId) throw new Error("Your session changed. Sign in again before paying.");
  const response = await request("/api/payments/create-order", {
    method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appointmentId }),
  });
  if (!response.ok) throw new Error("Could not start payment. Your reservation may have expired. Check your appointments before retrying.");
  const order = await response.json();
  if (order.appointmentId !== appointmentId || typeof order.orderId !== "string" || !order.orderId ||
      typeof order.keyId !== "string" || !order.keyId || !Number.isSafeInteger(order.amountPaise) || order.amountPaise <= 0 ||
      typeof order.currency !== "string" || !order.currency) throw new Error("Payment details could not be verified. Check your appointments before retrying.");
  onStage("opening");
  const payment = await checkout({ keyId: order.keyId, orderId: order.orderId, amountPaise: order.amountPaise,
    currency: order.currency, name: "Medrella Healthcare", description: "Appointment consultation" });
  onStage("verifying");
  if (payment.razorpay_order_id !== order.orderId) throw new Error("Payment order did not match. Check your payment status before retrying.");
  const verification = await request("/api/payments/verify", {
    method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appointmentId, razorpayOrderId: payment.razorpay_order_id,
      razorpayPaymentId: payment.razorpay_payment_id, razorpaySignature: payment.razorpay_signature }),
  });
  if (!verification.ok) throw new Error("Payment verification is pending. If money was deducted, check your appointments and payment history before paying again.");
  const result = await verification.json();
  if (result.success !== true) throw new Error(result.lateCapture
    ? "Payment was received after the reservation expired. Your appointment was not confirmed; a refund has been queued."
    : "Payment could not be confirmed. Check your appointments and payment history before paying again.");
}
