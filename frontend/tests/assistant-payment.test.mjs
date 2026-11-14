import assert from "node:assert/strict";
import { it } from "node:test";
import { payForAssistantHold } from "../components/assistant/assistant-payment.ts";

const order = { appointmentId: "hold", orderId: "order_1", keyId: "test_key", amountPaise: 60000, currency: "INR" };
const payment = { razorpay_order_id: "order_1", razorpay_payment_id: "pay_1", razorpay_signature: "signature" };
const json = (body) => Response.json(body);
function api(result = { success: true }, orderData = order) {
  const calls = [];
  return { calls, request: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("get-session")) return json({ user: { id: "patient" } });
    if (url.endsWith("create-order")) return json(orderData);
    return json(result);
  } };
}
it("opens checkout for the existing hold and verifies payment with the backend", async () => {
  const { calls, request } = api();
  const stages = [];
  await payForAssistantHold("hold", "patient", async (options) => {
    assert.equal(options.orderId, order.orderId);
    assert.equal(options.amountPaise, 60000);
    assert.equal(calls.length, 2);
    return payment;
  }, request, (stage) => stages.push(stage));
  assert.deepEqual(stages, ["opening", "verifying"]);
  assert.deepEqual(JSON.parse(calls[2].options.body), { appointmentId: "hold", razorpayOrderId: "order_1", razorpayPaymentId: "pay_1", razorpaySignature: "signature" });
  assert.ok(calls.every(({ options }) => options.credentials === "include"));
});
it("keeps a dismissed checkout retryable without verifying or creating a new booking", async () => {
  const { calls, request } = api();
  await assert.rejects(payForAssistantHold("hold", "patient", async () => { throw new Error("PAYMENT_DISMISSED"); }, request), /PAYMENT_DISMISSED/);
  assert.equal(calls.length, 2);
});
it("does not report success when backend verification rejects a late payment", async () => {
  const { request } = api({ success: false, lateCapture: true });
  await assert.rejects(payForAssistantHold("hold", "patient", async () => payment, request), /refund/);
});
it("rejects changed sessions and mismatched orders before checkout", async () => {
  let opened = false;
  const checkout = async () => { opened = true; return payment; };
  const { request } = api();
  await assert.rejects(payForAssistantHold("hold", "other-patient", checkout, request), /session changed/);
  const wrong = api({ success: true }, { ...order, appointmentId: "other-hold" });
  await assert.rejects(payForAssistantHold("hold", "patient", checkout, wrong.request), /could not be verified/);
  assert.equal(opened, false);
});
