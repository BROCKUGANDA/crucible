import { describe, expect, it } from "vitest";
import { treasuryConnectionState } from "../src/lib/treasury-view";

const SAFE = "0x1111111111111111111111111111111111111111";

describe("treasury connection gate", () => {
  it("refuses to show treasury information before a deployment is configured", () => {
    expect(treasuryConnectionState({ configured: false })).toBe("unconfigured");
  });

  it("distinguishes a pending treasury read from a failed read", () => {
    expect(
      treasuryConnectionState({ configured: true, treasuryLoading: true }),
    ).toBe("loading-address");
    expect(
      treasuryConnectionState({ configured: true, treasuryError: true }),
    ).toBe("unavailable-address");
  });

  it("requires a connected wallet", () => {
    expect(
      treasuryConnectionState({ configured: true, treasuryAddress: SAFE }),
    ).toBe("disconnected");
  });

  it("rejects a personal wallet even when it is connected", () => {
    expect(
      treasuryConnectionState({
        configured: true,
        connectedAddress: "0x2222222222222222222222222222222222222222",
        treasuryAddress: SAFE,
      }),
    ).toBe("wrong-wallet");
  });

  it("accepts only the exact Treasury Safe address, case-insensitively", () => {
    expect(
      treasuryConnectionState({
        configured: true,
        connectedAddress: SAFE.toLowerCase(),
        treasuryAddress: SAFE,
      }),
    ).toBe("treasury");
  });
});
