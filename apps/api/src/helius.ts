import { Hono } from "hono";

type HeliusConfig =
  | { configured: false; reason: "missing_api_key" | "invalid_api_key" | "unsupported_override" }
  | { configured: true; rpcUrl: string; wsUrl: string };

/** Server-only credentials. Never serialize this result or log its URLs. */
export function resolveHeliusConfig(env: Readonly<Record<string, string | undefined>>): HeliusConfig {
  if (["HELIUS_RPC_URL", "HELIUS_WS_URL", "NEXT_PUBLIC_HELIUS_API_KEY"].some((name) => env[name] !== undefined)) {
    return { configured: false, reason: "unsupported_override" };
  }
  const key = env.HELIUS_API_KEY;
  if (!key) return { configured: false, reason: "missing_api_key" };
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(key)) {
    return { configured: false, reason: "invalid_api_key" };
  }
  return {
    configured: true,
    rpcUrl: `https://mainnet.helius-rpc.com/?api-key=${key}`,
    wsUrl: `wss://mainnet.helius-rpc.com/?api-key=${key}`,
  };
}

/** Configuration health only: no RPC request, subscription, or financial capability. */
export function createHeliusRoutes(): Hono {
  const app = new Hono();
  app.get("/health", (c) => {
    const config = resolveHeliusConfig(process.env);
    c.header("Cache-Control", "no-store");
    return c.json({
      provider: "helius",
      network: "solana-mainnet",
      configured: config.configured,
      reason: config.configured ? null : config.reason,
      check: "configuration_only",
      rpcConnectivity: "unverified",
      wsConnectivity: "unverified",
      financialOperationsEnabled: false,
    }, config.configured ? 200 : 503);
  });
  return app;
}