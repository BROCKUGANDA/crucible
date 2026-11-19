import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveHeliusConfig, createHeliusRoutes } from "../src/helius.js";
import { emptyModel } from "@crucible/indexer";
import { createApp } from "../src/app.js";

const key = "offline-test-credential";
afterEach(() => vi.unstubAllEnvs());

describe("server-only Helius configuration", () => {
  it("fails closed without credentials", () => {
    expect(resolveHeliusConfig({})).toEqual({ configured: false, reason: "missing_api_key" });
  });

  it.each(["", " ", " key", "key\n", "a&b", "a?b", "a/b", "a#b"])("rejects malformed credentials %j", (value) => {
    expect(resolveHeliusConfig({ HELIUS_API_KEY: value }).configured).toBe(false);
  });

  it("derives only fixed mainnet TLS endpoints", () => {
    expect(resolveHeliusConfig({ HELIUS_API_KEY: key })).toEqual({
      configured: true,
      rpcUrl: `https://mainnet.helius-rpc.com/?api-key=${key}`,
      wsUrl: `wss://mainnet.helius-rpc.com/?api-key=${key}`,
    });
  });

  it("enforces the credential length boundary", () => {
    expect(resolveHeliusConfig({ HELIUS_API_KEY: "a".repeat(256) }).configured).toBe(true);
    expect(resolveHeliusConfig({ HELIUS_API_KEY: "a".repeat(257) }))
      .toEqual({ configured: false, reason: "invalid_api_key" });
  });

  it.each(["HELIUS_RPC_URL", "HELIUS_WS_URL", "NEXT_PUBLIC_HELIUS_API_KEY"])("refuses unsupported override %s", (name) => {
    expect(resolveHeliusConfig({ HELIUS_API_KEY: key, [name]: "https://untrusted.invalid" }))
      .toEqual({ configured: false, reason: "unsupported_override" });
  });

  it.each([undefined, key])("health never makes network calls or exposes credentials (%s)", async (value) => {
    vi.stubEnv("HELIUS_API_KEY", value);
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("network forbidden"); });
    try {
      const routes = createHeliusRoutes();
      const response = await routes.request("/health");
      expect(response.status).toBe(value ? 200 : 503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.json();
      expect(body).toEqual({
        provider: "helius", network: "solana-mainnet", configured: !!value,
        reason: value ? null : "missing_api_key", check: "configuration_only",
        rpcConnectivity: "unverified", wsConnectivity: "unverified", financialOperationsEnabled: false,
      });
      expect(JSON.stringify(body)).not.toContain(key);
      expect(JSON.stringify(body)).not.toContain("api-key=");
      expect(fetch).not.toHaveBeenCalled();
      expect((await routes.request("/health", { method: "POST" })).status).toBe(404);
    } finally {
      fetch.mockRestore();
    }
  });

  it("mounts the configuration health route in the API", async () => {
    vi.stubEnv("HELIUS_API_KEY", undefined);
    const app = createApp({ getModel: () => emptyModel() }, { rateLimit: false });
    const response = await app.request("/v1/integrations/helius/health");
    expect(response.status).toBe(503);
    expect((await response.json()).check).toBe("configuration_only");
  });
});