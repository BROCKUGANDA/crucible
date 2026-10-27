#!/usr/bin/env node
/**
 * Funded test wallet service — dispenses test ETH on Base Sepolia.
 *
 * A separate process from `apps/api`, holding its own CDP credential
 * (ADR-0015 §1). The API may ask it for an allocation over an internal
 * socket; it may not hold the key.
 *
 * Routes:
 *   GET  /health          — liveness
 *   POST /allocate        — request test ETH for a wallet
 *   POST /onramp/session  — mint one single-use Coinbase Onramp session URL
 *
 * The funder is not reachable from the browser: it is bound to loopback on a
 * port the API knows, never exposed to the public network.
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cdpConfig, createOnrampSession, credentialProblem, NETWORK, transferUsdc } from "./cdp.js";
import { CapTracker, MAX_PER_ALLOCATION_ETH, MAX_PER_DAY_ETH, MAX_PER_WALLET_PER_DAY_ETH } from "./cap.js";
import { allocationPolicy, consultRisk, FACTOR_UNKNOWN_WALLET } from "./risk.js";
import type { AllocateResponse, HealthResponse } from "./types.js";

const port = Number(process.env.FUNDER_PORT ?? 8788);
const host = process.env.FUNDER_HOST ?? "127.0.0.1";
/**
 * Where the identity service listens. Loopback by default, because both processes run on the
 * same host and the score is not a secret worth leaking to the network. Empty disables the
 * consultation and the funder says so in every allocation rather than pretending a clean read.
 */
const identityUrl = (process.env.IDENTITY_API_URL ?? "http://127.0.0.1:8787").trim();

const cfg = cdpConfig();
const problem = credentialProblem(cfg);
const configured = problem === null;
if (problem) {
  // A missing key is a configuration state, not a reason to crash the container. The funder
  // answers `/health` with `configured:false`, and both money paths refuse with that reason;
  // the API reports the same fact instead of a dead socket. Credentials can be supplied later
  // without changing the image.
  console.error(`[funder] starting WITHOUT CDP credentials; money paths will refuse.\n${problem}`);
} else {
  console.log(`[funder] CDP ${cfg.envName} · ${NETWORK} · ${cfg.baseUrl}`);
}

const caps = new CapTracker();
const app = new Hono();

/** Validate an Ethereum address (checksum optional). */
function isEthAddress(raw: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(raw);
}

app.get("/health", (c) => {
  const health: HealthResponse = {
    ok: true,
    service: "funder",
    network: NETWORK,
    configured,
    reason: configured ? null : "CDP credentials are not configured on this host",
  };
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

  if (!configured) {
    const res: AllocateResponse = {
      ok: false,
      wallet,
      requestedEth: requested.toString(),
      grantedEth: null,
      transferId: null,
      reason: "funder is not configured: CDP credentials are missing",
      risk: {
        pUniqueHuman: null,
        factor: 0,
        reason: "funder is not configured",
        available: false,
      },
    };
    return c.json(res, 503);
  }

  // What the identity service knows about this wallet, before any caps are applied.
  //
  // A wallet with no history scores the base rate and the API's decision layer says "deny" —
  // that wallet is the one a faucet exists for, so absence of evidence sizes the drip down
  // rather than refusing it. Only a slash refuses. `available: false` is reported, never
  // papered over: an unreachable service is a different answer from a clean score.
  const consult = await consultRisk(wallet, { apiUrl: identityUrl });
  const policy = consult.ok
    ? allocationPolicy(consult.view)
    : {
        factor: FACTOR_UNKNOWN_WALLET,
        reason: `identity service unavailable (${consult.reason}); base allocation`,
      };
  const risk = {
    pUniqueHuman: consult.ok ? consult.view.pUniqueHuman : null,
    factor: policy.factor,
    reason: policy.reason,
    available: consult.ok,
  };

  if (policy.factor === 0) {
    caps.record(wallet, requested, 0, 0, false, policy.reason, risk);
    const res: AllocateResponse = {
      ok: false,
      wallet,
      requestedEth: requested.toString(),
      grantedEth: null,
      transferId: null,
      reason: policy.reason,
      risk,
    };
    console.log(`[funder] ${wallet} refused by risk policy: ${policy.reason}`);
    return c.json(res, 403);
  }

  // Scale the request by the policy, floored to six decimals: rounding up would overstate
  // what left the wallet, the same rule every ETH figure in this repo follows.
  const sized = Math.floor(requested * policy.factor * 1e6) / 1e6;

  // Estimate before spend: check caps without recording.
  const estimate = caps.estimate(wallet, sized);
  if (!estimate.ok) {
    caps.record(wallet, requested, 0, 0, false, estimate.reason ?? undefined, risk);
    const res: AllocateResponse = {
      ok: false,
      wallet,
      requestedEth: requested.toString(),
      grantedEth: null,
      transferId: null,
      reason: estimate.reason,
      risk,
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

  caps.record(wallet, requested, estimate.estimated, granted, ok, reason, risk);

  const res: AllocateResponse = {
    ok,
    wallet,
    requestedEth: requested.toString(),
    grantedEth: ok ? granted.toString() : null,
    transferId,
    reason: ok ? null : reason,
    risk,
  };
  return c.json(res, ok ? 200 : 402);
});

/**
 * Mint one Coinbase Onramp session for a sponsor wallet.
 *
 * The URL is single-use and expires in minutes. It is returned with `no-store` and is never
 * logged: the token in the URL is the credential for that one purchase. The CDP key stays here;
 * the API only relays the result.
 */
app.post("/onramp/session", async (c) => {
  let body: { wallet?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "request body must be JSON" }, 400);
  }

  const wallet = String(body.wallet ?? "").trim();
  if (!isEthAddress(wallet)) {
    return c.json({ error: "wallet must be a 0x-prefixed 20-byte Ethereum address" }, 400);
  }

  if (!configured) {
    c.header("Cache-Control", "no-store");
    return c.json(
      { ok: false, configured: false, reason: "No CDP credentials are configured on this host" },
      503,
    );
  }

  try {
    const { onrampUrl } = await createOnrampSession(cfg, wallet);
    c.header("Cache-Control", "no-store");
    return c.json({ ok: true, url: onrampUrl });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // Name the failure, never the URL or token.
    console.error(`[funder] onramp session failed: ${reason}`);
    c.header("Cache-Control", "no-store");
    return c.json({ ok: false, reason }, 502);
  }
});

app.notFound((c) => c.json({ error: "not found" }, 404));

serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  console.log(`[funder] listening on http://${info.address}:${info.port}`);
});
