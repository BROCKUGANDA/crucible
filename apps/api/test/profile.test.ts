import { describe, expect, it } from "vitest";
import { resolveProfile, validateProfile } from "../src/profile.js";

/**
 * The profile gate.
 *
 * Preview and production refuse at boot on purpose — the runbook's gates are the price
 * of admission, and a profile that starts before its gates exist is a profile nobody can
 * trust. These tests pin the refusals, because a gate that cannot say no is decoration.
 */

describe("resolveProfile", () => {
  it("defaults to demo when unset, and accepts the three names case-insensitively", () => {
    expect(resolveProfile(undefined)).toBe("demo");
    expect(resolveProfile(" Demo ")).toBe("demo");
    expect(resolveProfile("preview")).toBe("preview");
    expect(resolveProfile("production")).toBe("production");
  });

  it("refuses anything else instead of guessing", () => {
    expect(() => resolveProfile("staging")).toThrow(/unknown CRUCIBLE_PROFILE/);
  });
});

describe("validateProfile", () => {
  const demo = { chainId: 31337, env: { REAL_VALUE_OPERATIONS: "0" } as NodeJS.ProcessEnv };

  it("allows demo on the local chain with real-value operations off", () => {
    expect(() => validateProfile("demo", demo)).not.toThrow();
    // Unset means 0: the demo's honest default.
    expect(() =>
      validateProfile("demo", { chainId: 31337, env: {} as NodeJS.ProcessEnv }),
    ).not.toThrow();
  });

  it("refuses demo on any other chain", () => {
    expect(() =>
      validateProfile("demo", { chainId: 1, env: { REAL_VALUE_OPERATIONS: "0" } as NodeJS.ProcessEnv }),
    ).toThrow(/requires CHAIN_ID=31337/);
  });

  it("refuses real-value operations on a valueless demo chain", () => {
    expect(() =>
      validateProfile("demo", {
        chainId: 31337,
        env: { REAL_VALUE_OPERATIONS: "1" } as NodeJS.ProcessEnv,
      }),
    ).toThrow(/requires REAL_VALUE_OPERATIONS=0/);
  });

  it("refuses preview and production in this build, naming the gates", () => {
    for (const profile of ["preview", "production"] as const) {
      expect(() => validateProfile(profile, demo)).toThrow(
        new RegExp(`${profile} is not implemented in this build`),
      );
    }
  });
});
