import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loginSchema, signupSchema } from "../lib/auth-validation.ts";

describe("auth validation", () => {
  it("accepts valid patient signup fields without a client role", () => {
    const result = signupSchema.parse({ name: "Alex Patient", email: "alex@example.com", password: "secure-pass-123", confirmPassword: "secure-pass-123", role: "doctor" });
    assert.equal("role" in result, false);
  });

  it("rejects weak passwords, invalid email and mismatched confirmation", () => {
    assert.equal(signupSchema.safeParse({ name: "A", email: "bad", password: "short", confirmPassword: "different" }).success, false);
  });

  it("requires a valid login email and password", () => {
    assert.equal(loginSchema.safeParse({ email: "invalid", password: "" }).success, false);
    assert.equal(loginSchema.safeParse({ email: "alex@example.com", password: "ok" }).success, true);
  });
});
