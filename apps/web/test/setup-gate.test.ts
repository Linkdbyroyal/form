import { describe, expect, it } from "vitest";
import { decideSetupAccess, parseSetupBody, SETUP_TOKEN_MIN_LENGTH } from "../lib/setup-gate";

/** One-time deployment route POST /api/setup: the access rule is pure and tested here without a database. */
const token = "t".repeat(SETUP_TOKEN_MIN_LENGTH);

describe("setup route gate", () => {
  it("does not exist without a configured token or with a short one", () => {
    expect(decideSetupAccess({ configuredToken: undefined, authorization: `Bearer ${token}`, adminExists: false })).toMatchObject({ allowed: false, status: 404 });
    expect(decideSetupAccess({ configuredToken: "short", authorization: "Bearer short", adminExists: false })).toMatchObject({ allowed: false, status: 404 });
  });
  it("rejects a missing, wrong or differently long bearer token", () => {
    expect(decideSetupAccess({ configuredToken: token, authorization: null, adminExists: false })).toMatchObject({ allowed: false, status: 401 });
    expect(decideSetupAccess({ configuredToken: token, authorization: `Bearer ${"u".repeat(SETUP_TOKEN_MIN_LENGTH)}`, adminExists: false })).toMatchObject({ allowed: false, status: 401 });
    expect(decideSetupAccess({ configuredToken: token, authorization: `Bearer ${token}x`, adminExists: false })).toMatchObject({ allowed: false, status: 401 });
    expect(decideSetupAccess({ configuredToken: token, authorization: token, adminExists: false })).toMatchObject({ allowed: false, status: 401 });
  });
  it("closes for good once an admin exists, even with the right token", () => {
    expect(decideSetupAccess({ configuredToken: token, authorization: `Bearer ${token}`, adminExists: true })).toMatchObject({ allowed: false, status: 409 });
  });
  it("allows exactly one case: right token and no admin yet", () => {
    expect(decideSetupAccess({ configuredToken: token, authorization: `bearer ${token}`, adminExists: false })).toEqual({ allowed: true });
  });
});

describe("setup body", () => {
  it("requires an email and a password of 12+ characters and normalises the email", () => {
    expect(parseSetupBody(null)).toMatchObject({ ok: false });
    expect(parseSetupBody({ email: "nope", password: "long-enough-password" })).toMatchObject({ ok: false });
    expect(parseSetupBody({ email: "a@b.test", password: "short" })).toMatchObject({ ok: false });
    expect(parseSetupBody({ email: " Owner@Example.test ", password: "long-enough-password" })).toEqual({ ok: true, body: { email: "owner@example.test", password: "long-enough-password", name: undefined } });
    expect(parseSetupBody({ email: "a@b.test", password: "long-enough-password", name: 5 })).toMatchObject({ ok: false });
  });
});
