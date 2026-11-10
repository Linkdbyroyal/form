import { describe, expect, it } from "vitest";
import { initialsOf, noAccessPath } from "../lib/account-helpers";

describe("account menu helpers", () => {
  it("builds avatar initials from the name, falling back to the e-mail", () => {
    expect(initialsOf("Dudley Haddocks", "d@x.test")).toBe("DH");
    expect(initialsOf("Superadmin", "owner@x.test")).toBe("SU");
    expect(initialsOf("", "owner@x.test")).toBe("O");
  });
  it("sends an authenticated user without the role to /no-access, never to /sign-in (redirect loop)", () => {
    expect(noAccessPath("/mission-control/team")).toBe("/no-access?area=%2Fmission-control%2Fteam");
    expect(noAccessPath("//evil")).toBe("/no-access?area=%2F");
    expect(noAccessPath("javascript:alert(1)")).toBe("/no-access?area=%2F");
  });
});
