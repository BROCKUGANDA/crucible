/**
 * @file stamp.ts — STAMP protocol-ownership domain, Phase 1-2 (sandbox + manual review).
 *
 * STAMP = Simple Token Agreement — Market Protected. Sandbox payment observer
 * (devnet fixtures, no real funds) + manual-review delivery request queue with
 * wallet challenge + vesting schedule calculator. NO automated delivery, NO
 * token issuance, NO real-money acceptance, NO production execution.
 *
 * Production (`STAMP_MODE=production`) always refuses payment verify, delivery
 * request approval, delivery execution, and vesting release: those require
 * counsel + MetaDAO sign-off outside this codebase (blueprint §18).
 *
 * STAMP does NOT replace Treasury/Owner Safes. Custody remains Safe multisig.
 */

import { Hono } from "hono";
import { verifiedSessionFromContext } from "./auth.js";

export type StampMode = "disabled" | "sandbox" | "manual_review" | "production";

export interface StampConfig {
  mode?: StampMode;
  /**
   * Wallets that may operate the manual-review queue. Defaults to
   * `CRUCIBLE_STAMP_REVIEWERS` (comma-separated). Empty means the queue is
   * closed — a signed-in wallet is not a reviewer.
   */
  reviewers?: readonly string[];
}

export function stampMode(): StampMode {
  const raw = (process.env.STAMP_MODE ?? "disabled").trim();
  if (raw === "sandbox" || raw === "manual_review" || raw === "production") return raw;
  return "disabled";
}

function reviewersFromEnv(): readonly string[] {
  return (process.env.CRUCIBLE_STAMP_REVIEWERS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** Integer-basis-point allocation with aggregate cap (no floating point). */
export function holderPortion(proRataBps: bigint, totalNetworkTokens: bigint): bigint {
  return (proRataBps * totalNetworkTokens) / 10000n;
}

/** Ratable reduction when aggregate exceeds the cap (2000 bps). */
export function ratableReduce(rawBps: bigint[], capBps = 2000n): bigint[] {
  const total = rawBps.reduce((a, b) => a + b, 0n);
  if (total <= capBps) return rawBps;
  const reduced = rawBps.map((b) => (b * capBps) / total);
  // Deterministic remainder: give the dust to the largest holder so the sum is exact.
  const sum = reduced.reduce((a, b) => a + b, 0n);
  const dust = capBps - sum;
  if (dust > 0n) {
    let idx = 0;
    for (let i = 1; i < rawBps.length; i++) if (rawBps[i]! > rawBps[idx]!) idx = i;
    reduced[idx] = reduced[idx]! + dust;
  }
  return reduced;
}

/** 24-month monthly release vector in integer base units; sums exactly. */
export function monthlyReleases(total: bigint, months = 24): bigint[] {
  const out: bigint[] = [];
  const per = total / BigInt(months);
  let sum = 0n;
  for (let i = 0; i < months - 1; i++) { out.push(per); sum += per; }
  out.push(total - sum);
  return out;
}

type InstrumentStatus = "DRAFT" | "COUNSEL_APPROVED" | "OFFERED" | "SIGNED" | "PAYMENT_PENDING" | "FUNDED" | "ELIGIBLE_FOR_DELIVERY" | "DELIVERY_REQUESTED" | "DELIVERY_APPROVED" | "DELIVERED" | "VESTING_ACTIVE" | "VESTING_COMPLETE";
type Instrument = {
  id: string; issuerId: string; holderRef: string; proRataBps: string;
  status: InstrumentStatus; version: string; createdAt: number;
  counselApproved?: boolean;
};
type Payment = {
  id: string; instrumentId: string; cluster: string; tokenMint: string;
  fromAddress: string; toApproved: string; amountBaseUnits: string;
  signature: string; status: "observed" | "verified" | "rejected"; createdAt: number;
};
type DeliveryRequest = {
  id: string; instrumentId: string; destination: string; challengeSig: string;
  status: "REQUESTED" | "SIGNATURE_VERIFIED" | "APPROVED" | "SUBMITTED" | "CONFIRMED" | "RECONCILED";
  schedule: string[]; createdAt: number;
};
const instruments = new Map<string, Instrument>();
const payments = new Map<string, Payment>();
const deliveries = new Map<string, DeliveryRequest>();
export function __resetStampForTests(): void { instruments.clear(); payments.clear(); deliveries.clear(); }

// Devnet-only allowlist for the sandbox observer. Anything else is rejected.
const SANDBOX_MINTS = new Set(["SANDBOX_USDC_DEVNET"]);
const SANDBOX_CLUSTERS = new Set(["devnet"]);

function requireManualReview(c: { json: (b: unknown, s?: number) => Response }, mode: StampMode) {
  if (mode === "sandbox") {
    return c.json({ error: "sandbox: payment recording is fixture-only; switch to manual_review with counsel approval for real review", code: "stamp_sandbox_only" }, 403);
  }
  if (mode === "production") {
    return c.json({ error: "production gate: signed manifest + counsel + MetaDAO required", code: "stamp_production_blocked" }, 403);
  }
  return null;
}

export function createStampRoutes(config: StampConfig = {}): Hono {
  const app = new Hono();
  const mode = config.mode ?? stampMode();
  const reviewers = config.reviewers ?? reviewersFromEnv();

  /**
   * STAMP's mutations are a reviewer's decisions — the instrument lifecycle and
   * the manual-review queue change legal status. Any authenticated wallet is
   * not authority here: the address must be on the configured reviewer list,
   * and an empty list closes the queue rather than opening it.
   */
  function requireReviewer(c: Parameters<typeof verifiedSessionFromContext>[0]): Response | null {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "unauthenticated", code: "no-credential" }, 401);
    if (reviewers.length === 0) {
      return c.json(
        { error: "no STAMP reviewer is configured on this host", code: "stamp_no_reviewers" },
        403,
      );
    }
    const address = session.payload.address.toLowerCase();
    if (!reviewers.some((reviewer) => reviewer.toLowerCase() === address)) {
      return c.json({ error: "STAMP mutations are the reviewer's view", code: "forbidden" }, 403);
    }
    return null;
  }

  if (mode === "disabled") {
    app.all("/*", (c) => c.json({ error: "STAMP is disabled on this host", code: "stamp_disabled" }, 404));
    return app;
  }

  // Public transparency projection (approved public data only).
  app.get("/protocol/ownership", (c) => c.json({
    mode,
    note: mode === "sandbox"
      ? "SANDBOX — NO LEGAL OR FINANCIAL EFFECT. No payment acceptance, no delivery."
      : "Read-only projection. Payment acceptance and delivery require counsel + MetaDAO approval.",
    docs: ["https://colosseum.com/stamp", "https://metadao.com/docs/stamp"],
  }));

  // Admin: create draft instrument (sandbox/manual_review only).
  app.post("/admin/instruments", async (c) => {
    const denied = requireReviewer(c);
    if (denied) return denied;
    if (mode === "production") {
      return c.json({ error: "production gate: signed manifest required", code: "stamp_production_blocked" }, 403);
    }
    let body: Record<string, unknown> = {};
    try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "invalid body" }, 400); }
    const id = `stamp-${Date.now().toString(36)}`;
    const inst: Instrument = {
      id,
      issuerId: String(body.issuerId ?? "issuer-sandbox"),
      holderRef: String(body.holderRef ?? ""),
      proRataBps: String(body.proRataBps ?? "0"),
      status: "DRAFT",
      version: "1",
      createdAt: Date.now(),
    };
    instruments.set(id, inst);
    return c.json({ instrument: inst }, 201);
  });

  app.get("/admin/instruments/:id", (c) => {
    const denied = requireReviewer(c);
    if (denied) return denied;
    const inst = instruments.get(c.req.param("id"));
    if (!inst) return c.json({ error: "not found", code: "not-found" }, 404);
    return c.json({ instrument: inst });
  });

  // Allocation calculator (pure, integer).
  app.post("/admin/allocate", async (c) => {
    const denied = requireReviewer(c);
    if (denied) return denied;
    let body: { rawBps?: string[]; totalNetworkTokens?: string } = {};
    try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: "invalid body" }, 400); }
    const raw = (body.rawBps ?? []).map((x) => BigInt(x));
    const effective = ratableReduce(raw);
    const total = body.totalNetworkTokens ? BigInt(body.totalNetworkTokens) : 0n;
    return c.json({
      rawBps: raw.map(String),
      effectiveBps: effective.map(String),
      portions: total > 0n ? effective.map((b) => holderPortion(b, total).toString()) : [],
      capped: raw.reduce((a, b) => a + b, 0n) > 2000n,
    });
  });

  // Sandbox payment observer: devnet fixtures only. Records an *observed*
  // fixture payment against a SIGNED instrument. Wrong mint/cluster → 400.
  app.post("/admin/payments/observe", async (c) => {
    const denied = requireReviewer(c);
    if (denied) return denied;
    let body: { instrumentId?: string; cluster?: string; tokenMint?: string; fromAddress?: string; toApproved?: string; amountBaseUnits?: string; signature?: string } = {};
    try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: "invalid body" }, 400); }
    const inst = body.instrumentId ? instruments.get(body.instrumentId) : undefined;
    if (!inst) return c.json({ error: "instrument not found", code: "not-found" }, 404);
    if (!body.cluster || !SANDBOX_CLUSTERS.has(body.cluster)) {
      return c.json({ error: "sandbox only accepts devnet cluster fixtures", code: "stamp_wrong_cluster" }, 400);
    }
    if (!body.tokenMint || !SANDBOX_MINTS.has(body.tokenMint)) {
      return c.json({ error: "sandbox only accepts SANDBOX_USDC_DEVNET fixture mint", code: "stamp_wrong_mint" }, 400);
    }
    if (!body.fromAddress || !body.toApproved || !body.amountBaseUnits || !body.signature) {
      return c.json({ error: "fromAddress, toApproved, amountBaseUnits, signature required", code: "bad-request" }, 400);
    }
    const id = `pay-${Date.now().toString(36)}`;
    const pay: Payment = {
      id, instrumentId: inst.id, cluster: body.cluster, tokenMint: body.tokenMint,
      fromAddress: body.fromAddress, toApproved: body.toApproved,
      amountBaseUnits: body.amountBaseUnits, signature: body.signature,
      status: "observed", createdAt: Date.now(),
    };
    payments.set(id, pay);
    inst.status = "PAYMENT_PENDING";
    return c.json({ payment: pay, note: "SANDBOX fixture — no legal or financial effect" }, 201);
  });

  app.get("/admin/payments/:id", (c) => {
    const denied = requireReviewer(c);
    if (denied) return denied;
    const pay = payments.get(c.req.param("id"));
    if (!pay) return c.json({ error: "not found", code: "not-found" }, 404);
    return c.json({ payment: pay });
  });

  // Manual-review verify: marks an observed fixture payment verified (reviewer
  // decision recorded). Blocked in sandbox (fixture-only) and production
  // (signed manifest required). Manual_review only.
  app.post("/admin/payments/:id/verify", async (c) => {
    const denied = requireReviewer(c);
    if (denied) return denied;
    const blocked = requireManualReview(c, mode);
    if (blocked) return blocked;
    const pay = payments.get(c.req.param("id"));
    if (!pay) return c.json({ error: "not found", code: "not-found" }, 404);
    pay.status = "verified";
    const inst = instruments.get(pay.instrumentId);
    if (inst) inst.status = "FUNDED";
    return c.json({ payment: pay, instrument: inst ?? null });
  });

  // Investor: delivery request (manual_review only). Destination + challenge
  // signature required; computes the 24-month integer schedule for review.
  app.post("/investor/instruments/:id/delivery-request", async (c) => {
    const denied = requireReviewer(c);
    if (denied) return denied;
    const blocked = requireManualReview(c, mode);
    if (blocked) return blocked;
    const inst = instruments.get(c.req.param("id"));
    if (!inst) return c.json({ error: "not found", code: "not-found" }, 404);
    if (inst.status !== "FUNDED" && inst.status !== "ELIGIBLE_FOR_DELIVERY") {
      return c.json({ error: "instrument must be FUNDED before delivery request", code: "stamp_not_funded" }, 400);
    }
    let body: { destination?: string; challengeSig?: string; deliveredAmount?: string } = {};
    try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: "invalid body" }, 400); }
    if (!body.destination || !body.challengeSig) {
      return c.json({ error: "destination and challengeSig required (address proof)", code: "bad-request" }, 400);
    }
    const total = body.deliveredAmount ? BigInt(body.deliveredAmount) : 0n;
    const schedule = total > 0n ? monthlyReleases(total).map(String) : [];
    const id = `del-${Date.now().toString(36)}`;
    const req: DeliveryRequest = {
      id, instrumentId: inst.id, destination: body.destination,
      challengeSig: body.challengeSig, status: "REQUESTED",
      schedule, createdAt: Date.now(),
    };
    deliveries.set(id, req);
    inst.status = "DELIVERY_REQUESTED";
    return c.json({ deliveryRequest: req, note: "MANUAL REVIEW required before any approval/execution" }, 201);
  });

  app.get("/investor/delivery/:id", (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "unauthenticated", code: "no-credential" }, 401);
    const req = deliveries.get(c.req.param("id"));
    if (!req) return c.json({ error: "not found", code: "not-found" }, 404);
    return c.json({ deliveryRequest: req });
  });

  // Vesting calculator (pure, integer): exact monthly vector + conservation proof.
  app.post("/investor/vesting/calculate", async (c) => {
    const session = verifiedSessionFromContext(c);
    if (!session) return c.json({ error: "unauthenticated", code: "no-credential" }, 401);
    let body: { deliveredAmount?: string; months?: number } = {};
    try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: "invalid body" }, 400); }
    if (!body.deliveredAmount) return c.json({ error: "deliveredAmount required", code: "bad-request" }, 400);
    const total = BigInt(body.deliveredAmount);
    const months = body.months && body.months > 0 && body.months <= 60 ? body.months : 24;
    const vector = monthlyReleases(total, months).map(String);
    const sum = vector.reduce((a, b) => a + BigInt(b), 0n);
    return c.json({ vector, sum: sum.toString(), conserved: sum === total, months });
  });

  return app;
}
