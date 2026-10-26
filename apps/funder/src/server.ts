#!/usr/bin/env node
/**
 * Funded test wallet service — dispenses test ETH on Base Sepolia.
 *
 * A separate process from `apps/api`, holding its own CDP credential
 * (ADR-0015 §1). The API may ask it for an allocation over an internal
 * socket; it may not hold the key.
 *
 * Routes:
 *   GET  /health     — liveness
 *   POST /allocate   — request test ETH for a wallet
 *
 * The funder is not reachable from the browser: it is bound to loopback on a
 * port the API knows, never exposed to the public network.
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cdpConfig, credentialProblem, NETWORK, transferUsdc } from "./cdp.js";
import { CapTracker, MAX_PER_ALLOCATION_ETH, MAX_PER_DAY_ETH, MAX_PER_WALLET_PER_DAY_ETH } from "./cap.js";
import type { AllocateResponse, HealthResponse } from "./types.js";

const port = Number(process.env.FUNDER_PORT ?? 8788);
const host = process.env.FUNDER_HOST ?? "127.0.0.1";

const cfg = cdpConfig();
const problem = credentialProblem(cfg);
if (problem) {
  console.error(problem);
  process.exit(2);
}

console.log(`[funder] CDP ${cfg.envName} · ${NETWORK} · ${cfg.baseUrl}`);

const caps = new CapTracker();
const app = new Hono();

/** Validate an Ethereum address (checksum optional). */
function isEthAddress(raw: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(raw);
}

app.get("/health", (c) => {
  const health: HealthResponse = { ok: true, service: "funder", network: NETWORK };
  return c.json(health);
});

app.post("/allocate", async (c) => {
  let body: { wallet?: string; amountEth?: number | string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "request body must be JSON" }, 400);
  }

  const wallet = String(body.wallet ?? "").trim();
  const requestedRaw = body.amountEth;
  const requested = Number(requestedRaw);

  if (!isEthAddress(wallet)) {
    return c.json({ error: "wallet must be a 0x-prefixed 20-byte Ethereum address" }, 400);
  }
  if (!Number.isFinite(requested) || requested <= 0 || requested > MAX_PER_ALLOCATION_ETH) {
    return c.json(
      {
        error: `amountEth must be greater than 0 and at most ${MAX_PER_ALLOCATION_ETH}`,
      },
      400,
    );
  }

  // Estimate before spend: check caps without recording.
  const estimate = caps.estimate(wallet, requested);
  if (!estimate.ok) {
    caps.record(wallet, requested, 0, 0, false, estimate.reason ?? undefined);
    const res: AllocateResponse = {
      ok: false,
      wallet,
      requestedEth: requested.toString(),
      grantedEth: null,
      transferId: null,
      reason: estimate.reason,
    };
    return c.json(res, 402);
  }

  // Spend: transfer USDC via CDP Payments on Base Sepolia.
  let granted = 0;
  let transferId: string | null = null;
  let reason: string | null = null;
  let ok = false;
  try {
    const result = await transferUsdc(cfg, wallet, estimate.estimated.toString());
    transferId = result.transferId;
    ok = result.status === "settled" || result.status === null; // null = no status field, treat as accepted
    granted = estimate.estimated;
    if (!ok) reason = `transfer returned status ${result.status ?? "unknown"}`;
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err);
  }

  caps.record(wallet, requested, estimate.estimated, granted, ok, reason);

  const res: AllocateResponse = {
    ok,
    wallet,
    requestedEth: requested.toString(),
    grantedEth: ok ? granted.toString() : null,
    transferId,
    reason: ok ? null : reason,
  };
  return c.json(res, ok ? 200 : 402);
});

app.notFound((c) => c.json({ error: "not found" }, 404));

serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  console.log(`[funder] listening on http://${info.address}:${info.port}`);
});
