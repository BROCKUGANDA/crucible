import { describe, expect, it } from "vitest";
import { createOnrampSession, type CdpConfig } from "../src/cdp.js";

const cfg = (envName: "sandbox" | "live"): CdpConfig => ({
  envName,
  baseUrl: "https://api.cdp.coinbase.com/platform/v2",
  keyFile: "",
  keyId: "id",
  keySecret: "secret",
});

const WALLET = "0x" + "ab".repeat(20);
const URL = "https://pay.coinbase.com/buy/select-asset?sessionToken=single-use";

type Api = (
  cfg: CdpConfig,
  args: string[],
) => Promise<{ json: unknown; status: number; stderr: string }>;

function apiReturning(json: unknown, status = 0): { api: Api; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    api: async (_cfg, args) => {
      calls.push(args);
      return { json, status, stderr: status === 0 ? "" : "boom" };
    },
  };
}

describe("Coinbase Onramp sessions", () => {
  it("builds an ETH-on-Ethereum session and returns the hosted URL", async () => {
    const { api, calls } = apiReturning({ session: { onrampUrl: URL } });
    const out = await createOnrampSession(cfg("sandbox"), WALLET, api);
    expect(out.onrampUrl).toBe(URL);

    const args = calls[0]!;
    expect(args).toContain("purchaseCurrency=ETH");
    expect(args).toContain("destinationNetwork=ethereum");
    expect(args).toContain(`destinationAddress=${WALLET}`);
    expect(args).toContain("partnerUserRef=sandbox-crucible");
  });

  it("does not put a sandbox partner reference on a live session", async () => {
    const { api, calls } = apiReturning({ session: { onrampUrl: URL } });
    await createOnrampSession(cfg("live"), WALLET, api);
    expect(calls[0]).not.toContain("partnerUserRef=sandbox-crucible");
  });

  it("refuses a URL that is not Coinbase-hosted", async () => {
    const { api } = apiReturning({ session: { onrampUrl: "https://evil.example/buy" } });
    await expect(createOnrampSession(cfg("sandbox"), WALLET, api)).rejects.toThrow(/onrampUrl/);
  });

  it("surfaces a CDP failure without returning a URL", async () => {
    const { api } = apiReturning({}, 1);
    await expect(createOnrampSession(cfg("sandbox"), WALLET, api)).rejects.toThrow(/CDP onramp session failed/);
  });
});
