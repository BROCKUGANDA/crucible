/**
 * @file routes.ts — the STAMP HTTP surface.
 *
 * Three audiences, three namespaces, one identity system:
 *
 *   `/protocol/*`  — public, approved aggregates only.
 *   `/admin/*`     — a named reviewer, mode-gated, evidence-backed.
 *   `/investor/*`  — a session principal bound to a holder record.
 *
 * The two rules that shape every handler:
 *
 *   1. **A wallet is not an identity.** Admin authority is a configured
 *      reviewer list, and investor authority is a reviewer-made binding
 *      between a holder record and a session address. Connecting a wallet
 *      grants neither.
 *   2. **Irreversible actions are gated on the production manifest**, not on
 *      the mode string alone. `stamp/mode.ts` owns that decision.
 *
 * Every command carries an idempotency key where a retry could create a second
 * record, and every mutation writes an audit event and an outbox row.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { verifiedSessionFromContext } from "../auth.js";
import { parseIdempotencyKey } from "../idempotency.js";
import {
  type AllocationInput,
  deliveryGate,
  deliveryQuantityGate,
  insiderParity,
  ipPerimeterGaps,
  paymentGate,
  tokenomicsGate,
  type IpAsset,
  type LockUpSchedule,
} from "@crucible/stamp-core";
import { productionGate, irreversibleActionsAllowed, resolveMode, type StampMode } from "./mode.js";
import { HttpSolanaRpc, verifyDelivery as verifyOnChain } from "@crucible/stamp-solana";
import {
  bindHolderPrincipal,
  calculateAllocations,
  createDeliveryRequest,
  createHolder,
  createInstrument,
  createIssuer,
  createVesting,
  availablePortionForInstrument,
  findPaymentBySignature,
  getModel,
  holderForPrincipal,
  instrumentExpiration,
  markNoticeDelivered,
  observePayment,
  prepareStructuringEvent,
  publicTransparency,
  reconciliationReport,
  record,
  scheduleNotices,
  transitionDelivery,
  transitionInstrument,
  transitionIssuer,
  vestingForInstrument,
} from "./store.js";
import {
  buildVestingSchedule,
  monthlyReleaseVector,
  reconcileVesting,
  vestingStateAt,
} from "@crucible/stamp-core";
import { sha256Hex } from "@crucible/stamp-core";

export interface StampConfig {
  mode?: StampMode;
  /** Wallets allowed to operate the manual-review console. */
  reviewers?: readonly string[];
  /**
   * The bound-reviewer list for holder-principal bindings. Defaults to the
   * reviewer list: binding a holder to a wallet is at least as sensitive as
   * approving an instrument.
   */
  binders?: readonly string[];
  /** A manifest path override, for tests and for an operator's explicit choice. */
  manifestPath?: string | null;
  /** An injected clock, so deadline tests are deterministic. */
  now?: () => number;
  /**
   * A read-only Solana RPC, used to verify a delivery against the chain.
   *
   * Absent means the chain read is not possible on this host, and the delivery
   * route says so instead of accepting a reviewer's word for a chain fact: the
   * app holds no key, and it also holds no licence to invent an observation.
   */
  solanaRpc?: { url: string; cluster: string; fetchImpl?: typeof fetch } | null;
}

function reviewersFromEnv(): readonly string[] {
  return (process.env.CRUCIBLE_STAMP_REVIEWERS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** A bounded JSON body, so a caller cannot stream an unbounded object at us. */
async function readJson<T>(c: Context): Promise<{ body: T | null; error: string | null }> {
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return { body: null, error: "content-type must be application/json" };
  }
  try {
    const raw = await c.req.text();
    if (raw.length > 64_000) return { body: null, error: "body too large" };
    return { body: JSON.parse(raw) as T, error: null };
  } catch {
    return { body: null, error: "invalid JSON body" };
  }
}

function badRequest(c: Context, error: string, code = "bad-request"): Response {
  return c.json({ error, code }, 400);
}

export function createStampRoutes(config: StampConfig = {}): Hono {
  const app = new Hono();
  const mode = config.mode ?? resolveMode();
  const reviewers = config.reviewers ?? reviewersFromEnv();
  const binders = config.binders ?? reviewers;
  const now = config.now ?? (() => Date.now());
  const gate = () => productionGate(config.manifestPath);

  if (mode === "disabled") {
    app.all("/*", (c) => c.json({ error: "STAMP is disabled on this host", code: "stamp_disabled" }, 404));
    return app;
  }

  /* ------------------------------------------------------------------ */
  /* Identity                                                            */
  /* ------------------------------------------------------------------ */

  function sessionOf(c: Context): { address: string } | null {
    const session = verifiedSessionFromContext(c);
    if (!session) return null;
    return { address: session.payload.address.toLowerCase() };
  }

  function requireReviewer(c: Context): Response | null {
    const session = sessionOf(c);
    if (!session) return c.json({ error: "unauthenticated", code: "no-credential" }, 401);
    if (reviewers.length === 0) {
      return c.json(
        { error: "no STAMP reviewer is configured on this host", code: "stamp_no_reviewers" },
        403,
      );
    }
    if (!reviewers.some((r) => r.toLowerCase() === session.address)) {
      return c.json({ error: "STAMP mutations are the reviewer's view", code: "forbidden" }, 403);
    }
    return null;
  }

  function requireBinder(c: Context): Response | null {
    const session = sessionOf(c);
    if (!session) return c.json({ error: "unauthenticated", code: "no-credential" }, 401);
    if (binders.length === 0) {
      return c.json({ error: "no STAMP holder binder is configured", code: "stamp_no_binders" }, 403);
    }
    if (!binders.some((b) => b.toLowerCase() === session.address)) {
      return c.json({ error: "binding a holder is the binder's view", code: "forbidden" }, 403);
    }
    return null;
  }

  /**
   * The investor's own holder record, resolved from the verified session.
   *
   * A caller cannot name a holder: the record is found by looking up the
   * session address in the binding table, so a stolen holder id is worth
   * nothing.
   */
  function investorHolder(c: Context): { holder: NonNullable<ReturnType<typeof holderForPrincipal>> } | Response {
    const session = sessionOf(c);
    if (!session) return c.json({ error: "unauthenticated", code: "no-credential" }, 401);
    const holder = holderForPrincipal(session.address);
    if (!holder) {
      return c.json(
        {
          error: "no holder record is bound to this session; the investor portal is opened by a reviewer",
          code: "stamp_holder_unbound",
        },
        403,
      );
    }
    return { holder };
  }

  /** Refuse an irreversible action unless the production manifest allows it. */
  function requireIrreversible(c: Context): Response | null {
    const verdict = irreversibleActionsAllowed(mode, gate());
    if (verdict.allowed) return null;
    return c.json({ error: verdict.reason, code: verdict.code }, 403);
  }

  /** Idempotency, scoped to the actor so a key cannot be replayed by another. */
  const seen = new Map<string, string>();
  function idempotent(c: Context, actor: string): { key: string | null; prior: string | null; error: string | null } {
    const { key, error } = parseIdempotencyKey(c.req.header("idempotency-key") ?? null);
    if (error) return { key: null, prior: null, error };
    if (!key) return { key: null, prior: null, error: null };
    const scoped = `${actor}\u0000${key}`;
    return { key: scoped, prior: seen.get(scoped) ?? null, error: null };
  }

  /* ------------------------------------------------------------------ */
  /* Public projection                                                    */
  /* ------------------------------------------------------------------ */

  app.get("/protocol/ownership", (c) =>
    c.json({
      mode,
      sandbox: mode === "sandbox",
      note:
        mode === "sandbox"
          ? "SANDBOX — NO LEGAL OR FINANCIAL EFFECT. Fixture observations only; no payment acceptance, no delivery."
          : "Read-only projection. Payment acceptance and delivery require the production preflight manifest.",
      production: gate(),
      docs: ["https://colosseum.com/stamp", "https://metadao.com/docs/stamp"],
    }),
  );

  app.get("/protocol/transparency", (c) => {
    const issuerId = c.req.query("issuer") ?? "";
    if (!issuerId) return badRequest(c, "issuer query parameter is required");
    return c.json({ transparency: publicTransparency(issuerId) });
  });

  app.get("/protocol/governance", (c) => {
    const issuerId = c.req.query("issuer") ?? "";
    const issuer = issuerId ? getModel().issuers.get(issuerId) : null;
    if (!issuer) return c.json({ governance: null, note: "no issuer is published" });
    return c.json({
      governance: {
        metaDaoProjectRef: issuer.metaDaoProjectRef,
        // MetaDAO's own pages are the authority; this surface links rather than
        // recreates a conflicting sale UI.
        stampDocs: "https://metadao.com/docs/stamp",
        listingDocs: "https://metadao.com/docs/create",
        treasuryDocs: "https://metadao.com/docs/treasury",
      },
    });
  });

  /* ------------------------------------------------------------------ */
  /* Admin: issuer                                                        */
  /* ------------------------------------------------------------------ */

  app.post("/admin/issuer", async (c) => {
    const denied = requireReviewer(c);
    if (denied) return denied;
    const { body, error } = await readJson<{
      tenantId?: string;
      legalEntityName?: string;
      entityType?: string;
      jurisdictionCode?: string;
      registrationNumber?: string;
      metaDaoProjectRef?: string;
      solanaCluster?: string;
      counselApprovalRef?: string;
    }>(c);
    if (error || !body) return badRequest(c, error ?? "invalid body");
    if (!body.legalEntityName?.trim()) return badRequest(c, "legalEntityName is required");
    if (!body.entityType?.trim()) return badRequest(c, "entityType is required");
    if (!body.jurisdictionCode?.trim()) return badRequest(c, "jurisdictionCode is required");
    const actor = sessionOf(c)!.address;
    const issuer = createIssuer({
      tenantId: body.tenantId ?? "default",
      legalEntityName: body.legalEntityName,
      entityType: body.entityType,
      jurisdictionCode: body.jurisdictionCode,
      registrationNumber: body.registrationNumber ?? null,
      metaDaoProjectRef: body.metaDaoProjectRef ?? null,
      solanaCluster: body.solanaCluster ?? process.env.STAMP_SOLANA_CLUSTER ?? "devnet",
      counselApprovalRef: body.counselApprovalRef ?? null,
    });
    record({
      actor,
      action: "issuer.created",
      issuerId: issuer.id,
      instrumentId: null,
      detail: issuer.legalEntityName,
      topic: "stamp.issuer.created",
      payload: { issuerId: issuer.id },
    });
    return c.json({ issuer }, 201);
  });

  app.get("/admin/issuer", (c) => {
    const denied = requireReviewer(c);
    if (denied) return denied;
    const id = c.req.query("id");
    if (id) {
      const issuer = getModel().issuers.get(id);
      if (!issuer) return c.json({ error: "not found", code: "not-found" }, 404);
      return c.json({ issuer });
    }
    return c.json({ issuers: [...getModel().issuers.values()] });
  });

  app.post("/admin/issuer/transition", async (c) => {
    const denied = requireReviewer(c);
    if (denied) return denied;
    const { body, error } = await readJson<{ issuerId?: string; to?: string; reviewRef?: string }>(c);
    if (error || !body) return badRequest(c, error ?? "invalid body");
    if (!body.issuerId || !body.to) return badRequest(c, "issuerId and to are required");
    const result = transitionIssuer(body.issuerId, body.to as never, sessionOf(c)!.address);
    if (!result.ok) return c.json({ error: result.reason, code: "stamp_invalid_transition" }, 409);
    return c.json({ issuer: result.issuer });
  });

  /* ------------------------------------------------------------------ */
  /* Admin: holders                                                       */
  /* ------------------------------------------------------------------ */

  app.post("/admin/holders", async (c) => {
    const denied = requireReviewer(c);
    if (denied) return denied;
    const { body, error } = await readJson<{
      issuerId?: string;
      partyType?: string;
      displayName?: string;
      contactRef?: string;
    }>(c);
    if (error || !body) return badRequest(c, error ?? "invalid body");
    if (!body.issuerId) return badRequest(c, "issuerId is required");
    if (!body.displayName?.trim()) return badRequest(c, "displayName is required");
    if (!getModel().issuers.has(body.issuerId)) return c.json({ error: "no such issuer", code: "not-found" }, 404);
    const holder = createHolder({
      issuerId: body.issuerId,
      partyType: (body.partyType as never) ?? "investor",
      displayName: body.displayName,
      contactRef: body.contactRef ?? null,
      actor: sessionOf(c)!.address,
    });
    return c.json({ holder }, 201);
  });

  /**
   * Bind a verified session address to a holder record.
   *
   * Only a binder may do this, and the binding is the investor's entire
   * authorization: without it the holder sees nothing.
   */
  app.post("/admin/holders/bind", async (c) => {
    const denied = requireBinder(c);
    if (denied) return denied;
    const { body, error } = await readJson<{ holderId?: string; principalAddress?: string }>(c);
    if (error || !body) return badRequest(c, error ?? "invalid body");
    if (!body.holderId || !body.principalAddress) {
      return badRequest(c, "holderId and principalAddress are required");
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(body.principalAddress)) {
      return badRequest(c, "principalAddress must be a 20-byte hex address");
    }
    const result = bindHolderPrincipal({
      holderId: body.holderId,
      principalAddress: body.principalAddress,
      actor: sessionOf(c)!.address,
    });
    if (!result.ok) return c.json({ error: result.reason, code: "not-found" }, 404);
    return c.json({ holder: result.holder });
  });

  /* ------------------------------------------------------------------ */
  /* Admin: instruments                                                   */
  /* ------------------------------------------------------------------ */

  app.post("/admin/instruments", async (c) => {
    const denied = requireReviewer(c);
    if (denied) return denied;
    const { body, error } = await readJson<{
      issuerId?: string;
      holderPartyId?: string;
      documentSha256?: string;
      documentUri?: string;
      issueDate?: number | string;
      purchasePriceMinor?: string;
      currency?: string;
      acceptedStablecoinMint?: string;
      approvedWallet?: string;
      proRataBps?: string;
    }>(c);
    if (error || !body) return badRequest(c, error ?? "invalid body");
    if (!body.issuerId) return badRequest(c, "issuerId is required");
    if (!body.holderPartyId) return badRequest(c, "holderPartyId is required");
    if (!body.documentSha256 || !/^[0-9a-f]{64}$/i.test(body.documentSha256)) {
      return badRequest(c, "documentSha256 must be a hex SHA-256 of the exact document");
    }
    if (!body.documentUri) return badRequest(c, "documentUri is required");
    if (!body.purchasePriceMinor || !/^[0-9]+$/.test(body.purchasePriceMinor)) {
      return badRequest(c, "purchasePriceMinor must be an integer string of minor units");
    }
    if (!body.proRataBps || !/^[0-9]+$/.test(body.proRataBps)) {
      return badRequest(c, "proRataBps must be an integer string of basis points");
    }
    if (!body.acceptedStablecoinMint) return badRequest(c, "acceptedStablecoinMint is required");
    if (!body.approvedWallet) return badRequest(c, "approvedWallet is required");
    if (!getModel().issuers.has(body.issuerId)) {
      return c.json({ error: "no such issuer", code: "not-found" }, 404);
    }
    if (!getModel().holders.has(body.holderPartyId)) {
      return c.json({ error: "no such holder", code: "not-found" }, 404);
    }
    const actor = sessionOf(c)!.address;
    const idem = idempotent(c, actor);
    if (idem.error) return badRequest(c, idem.error);
    if (idem.key && idem.prior) {
      const existing = getModel().instruments.get(idem.prior);
      if (existing) return c.json({ instrument: existing, replayed: true }, 200);
    }
    const instrument = createInstrument({
      issuerId: body.issuerId,
      holderPartyId: body.holderPartyId,
      documentSha256: body.documentSha256.toLowerCase(),
      documentUri: body.documentUri,
      issueDate:
        typeof body.issueDate === "number"
          ? body.issueDate
          : body.issueDate
            ? Date.parse(body.issueDate)
            : now(),
      purchasePriceMinor: body.purchasePriceMinor,
      currency: body.currency ?? "USDC",
      acceptedStablecoinMint: body.acceptedStablecoinMint,
      approvedWallet: body.approvedWallet,
      proRataBps: body.proRataBps,
      createdBy: actor,
    });
    if (idem.key) seen.set(idem.key, instrument.id);
    return c.json({ instrument }, 201);
  });

  app.get("/admin/instruments/:id", (c) => {
    const denied = requireReviewer(c);
    if (denied) return denied;
    const instrument = getModel().instruments.get(c.req.param("id"));
    if (!instrument) return c.json({ error: "not found", code: "not-found" }, 404);
    const holder = getModel().holders.get(instrument.holderPartyId) ?? null;
    const vesting = vestingForInstrument(instrument.id);
    return c.json({
      instrument,
      holder,
      expiration: instrumentExpiration(instrument.id, now()),
      vesting,
    });
  });

  app.post("/admin/instruments/:id/approve", async (c) => {
    const denied = requireReviewer(c);
    if (denied) return denied;
    const { body, error } = await readJson<{ reviewRef?: string }>(c);
    if (error) return badRequest(c, error);
    const actor = sessionOf(c)!.address;
    const result = transitionInstrument(
      c.req.param("id"),
      "COUNSEL_APPROVED",
      actor,
      body?.reviewRef ?? "counsel approval recorded",
    );
    if (!result.ok) return c.json({ error: result.reason, code: "stamp_invalid_transition" }, 409);
    return c.json({ instrument: result.instrument });
  });

  app.post("/admin/instruments/:id/transition", async (c) => {
    const denied = requireReviewer(c);
    if (denied) return denied;
    const { body, error } = await readJson<{ to?: string; detail?: string }>(c);
    if (error || !body?.to) return badRequest(c, error ?? "to is required");
    const result = transitionInstrument(c.req.param("id"), body.to as never, sessionOf(c)!.address, body.detail ?? "");
    if (!result.ok) return c.json({ error: result.reason, code: "stamp_invalid_transition" }, 409);
    return c.json({ instrument: result.instrument });
  });

  /**
   * Record the signature on the *exact* document.
   *
   * The signed hash must equal the draft's hash: a signature on a different
   * document is not a signature on this instrument, and the STAMP's whole
   * purpose is that the holder agreed to the bytes.
   */
  app.post("/admin/instruments/:id/record-signature", async (c) => {
    const denied = requireReviewer(c);
    if (denied) return denied;
    const { body, error } = await readJson<{ signedDocumentSha256?: string; signedAt?: number | string }>(c);
    if (error || !body?.signedDocumentSha256) {
      return badRequest(c, error ?? "signedDocumentSha256 is required");
    }
    const instrument = getModel().instruments.get(c.req.param("id"));
    if (!instrument) return c.json({ error: "not found", code: "not-found" }, 404);
    if (body.signedDocumentSha256.toLowerCase() !== instrument.documentSha256) {
      return c.json(
        {
          error: `the signed document hash ${body.signedDocumentSha256} is not the instrument's document hash ${instrument.documentSha256}`,
          code: "stamp_document_hash_mismatch",
        },
        409,
      );
    }
    const transition = transitionInstrument(
      instrument.id,
      "SIGNED",
      sessionOf(c)!.address,
      "signature recorded",
    );
    if (!transition.ok) return c.json({ error: transition.reason, code: "stamp_invalid_transition" }, 409);
    instrument.signedDocumentSha256 = body.signedDocumentSha256.toLowerCase();
    instrument.signedAt =
      typeof body.signedAt === "number" ? body.signedAt : body.signedAt ? Date.parse(body.signedAt) : now();
    record({
      actor: sessionOf(c)!.address,
      action: "instrument.signature_recorded",
      issuerId: instrument.issuerId,
      instrumentId: instrument.id,
      payloadHash: instrument.signedDocumentSha256,
      detail: `signed at ${new Date(instrument.signedAt).toISOString()}`,
    });
    // A signed instrument is not funded: move it to PAYMENT_PENDING only.
    const pending = transitionInstrument(
      instrument.id,
      "PAYMENT_PENDING",
      sessionOf(c)!.address,
      "awaiting payment verification",
    );
    return c.json({ instrument: pending.ok ? pending.instrument : instrument });
  });

  /* ------------------------------------------------------------------ */
  /* Admin: allocations                                                   */
  /* ------------------------------------------------------------------ */

  app.post("/admin/allocations", async (c) => {
    const denied = requireReviewer(c);
    if (denied) return denied;
    const { body, error } = await readJson<{
      issuerId?: string;
      totalNetworkTokens?: string;
      holders?: { holderId: string; proRataBps: string }[];
      capBps?: string;
    }>(c);
    if (error || !body) return badRequest(c, error ?? "invalid body");
    if (!body.issuerId) return badRequest(c, "issuerId is required");
    if (!body.totalNetworkTokens || !/^[0-9]+$/.test(body.totalNetworkTokens)) {
      return badRequest(c, "totalNetworkTokens must be an integer string of base units");
    }
    if (!Array.isArray(body.holders) || body.holders.length === 0) {
      return badRequest(c, "holders must be a non-empty array");
    }
    const inputs: AllocationInput[] = [];
    for (const entry of body.holders) {
      if (!entry?.holderId || !/^[0-9]+$/.test(String(entry.proRataBps))) {
        return badRequest(c, "each holder needs a holderId and an integer proRataBps");
      }
      inputs.push({ holderId: entry.holderId, rawProRataBps: BigInt(entry.proRataBps) });
    }
    const result = calculateAllocations({
      issuerId: body.issuerId,
      inputs,
      totalNetworkTokens: BigInt(body.totalNetworkTokens),
      actor: sessionOf(c)!.address,
      capBps: body.capBps ? BigInt(body.capBps) : undefined,
    });
    return c.json(result);
  });

  /** The legacy aggregate calculator, kept for the console's live preview. */
  app.post("/admin/allocate", async (c) => {
    const denied = requireReviewer(c);
    if (denied) return denied;
    const { body, error } = await readJson<{ rawBps?: string[]; totalNetworkTokens?: string }>(c);
    if (error || !body) return badRequest(c, error ?? "invalid body");
    if (!Array.isArray(body.rawBps)) return badRequest(c, "rawBps must be an array");
    if (body.rawBps.some((b) => !/^[0-9]+$/.test(b))) {
      return badRequest(c, "every rawBps entry must be an integer string");
    }
    const result = calculateAllocations({
      issuerId: "preview",
      inputs: body.rawBps.map((b, i) => ({ holderId: `h${i}`, rawProRataBps: BigInt(b) })),
      totalNetworkTokens: body.totalNetworkTokens ? BigInt(body.totalNetworkTokens) : 0n,
      actor: sessionOf(c)!.address,
    });
    return c.json({
      rawBps: body.rawBps,
      effectiveBps: result.snapshots.map((s) => s.effectiveProRataBps),
      portions: result.snapshots.map((s) => s.holderPortionTokens),
      capped: result.capped,
      conserved: result.conserved,
    });
  });

  /* ------------------------------------------------------------------ */
  /* Admin: payments                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Observe a payment.
   *
   * In `sandbox` the cluster and mint must be the fixture pair. In
   * `manual_review` a reviewer records a real observation, and the observation
   * is still only *observed*: verification is a second, separate decision.
   */
  app.post("/admin/payments/observe", async (c) => {
    const denied = requireReviewer(c);
    if (denied) return denied;
    const { body, error } = await readJson<{
      instrumentId?: string;
      network?: string;
      cluster?: string;
      tokenMint?: string;
      fromAddress?: string;
      toApproved?: string;
      amountBaseUnits?: string;
      signature?: string;
      blockSlot?: number;
      finalityStatus?: string;
      canonicalityStatus?: string;
      verificationPayloadHash?: string;
    }>(c);
    if (error || !body) return badRequest(c, error ?? "invalid body");
    const instrument = body.instrumentId ? getModel().instruments.get(body.instrumentId) : undefined;
    if (!instrument) return c.json({ error: "instrument not found", code: "not-found" }, 404);
    if (!body.amountBaseUnits || !/^[0-9]+$/.test(body.amountBaseUnits)) {
      return badRequest(c, "amountBaseUnits must be an integer string");
    }
    if (!body.fromAddress || !body.toApproved || !body.signature) {
      return badRequest(c, "fromAddress, toApproved and signature are required");
    }
    const network = body.network ?? "solana";

    // A signature is unique per (network, mint): a duplicate is a replay, not a
    // second payment.
    if (findPaymentBySignature(network, body.tokenMint ?? "", body.signature)) {
      return c.json(
        { error: "this signature has already been observed for this mint", code: "stamp_duplicate_payment" },
        409,
      );
    }

    if (mode === "sandbox") {
      if (body.cluster !== "devnet") {
        return c.json({ error: "sandbox only accepts devnet fixtures", code: "stamp_wrong_cluster" }, 400);
      }
      if (body.tokenMint !== "SANDBOX_USDC_DEVNET") {
        return c.json(
          { error: "sandbox only accepts the SANDBOX_USDC_DEVNET fixture mint", code: "stamp_wrong_mint" },
          400,
        );
      }
    }

    const payloadHash =
      body.verificationPayloadHash ??
      sha256Hex(
        JSON.stringify({
          network,
          cluster: body.cluster ?? null,
          mint: body.tokenMint ?? null,
          from: body.fromAddress,
          to: body.toApproved,
          amount: body.amountBaseUnits,
          signature: body.signature,
          slot: body.blockSlot ?? null,
        }),
      );

    const payment = observePayment({
      instrumentId: instrument.id,
      network,
      cluster: body.cluster ?? "devnet",
      tokenMint: body.tokenMint ?? "",
      fromAddress: body.fromAddress,
      toApprovedAddress: body.toApproved,
      amountBaseUnits: body.amountBaseUnits,
      transactionSignature: body.signature,
      blockSlot: body.blockSlot ?? null,
      finalityStatus: (body.finalityStatus as never) ?? "submitted",
      canonicalityStatus: (body.canonicalityStatus as never) ?? "pending",
      verificationPayloadHash: payloadHash,
      actor: sessionOf(c)!.address,
    });
    return c.json(
      {
        payment,
        note:
          mode === "sandbox"
            ? "SANDBOX fixture — no legal or financial effect"
            : "observed only; verification is a separate reviewer decision",
      },
      201,
    );
  });

  app.get("/admin/payments/:id", (c) => {
    const denied = requireReviewer(c);
    if (denied) return denied;
    const payment = getModel().payments.get(c.req.param("id"));
    if (!payment) return c.json({ error: "not found", code: "not-found" }, 404);
    return c.json({ payment });
  });

  /**
   * Verify an observed payment.
   *
   * In `manual_review` this is the reviewer's recorded decision, and it is what
   * moves an instrument to FUNDED. In `sandbox` it is refused, because a
   * fixture must never produce a funded instrument: the two tests that would
   * otherwise pass on a fixture are the two that matter most.
   */
  app.post("/admin/payments/:id/verify", async (c) => {
    const denied = requireReviewer(c);
    if (denied) return denied;
    const payment = getModel().payments.get(c.req.param("id"));
    if (!payment) return c.json({ error: "not found", code: "not-found" }, 404);
    if (mode === "sandbox") {
      return c.json(
        {
          error: "sandbox: a fixture observation must never produce a funded instrument",
          code: "stamp_sandbox_only",
        },
        403,
      );
    }
    if (mode === "production") {
      const guard = requireIrreversible(c);
      if (guard) return guard;
    }
    const instrument = getModel().instruments.get(payment.instrumentId);
    if (!instrument) return c.json({ error: "instrument not found", code: "not-found" }, 404);

    // The gate is the domain's, not the handler's: the same function the
    // blueprint names decides, and it returns every reason at once.
    const verdict = paymentGate({
      approvedMint: instrument.acceptedStablecoinMint,
      observedMint: payment.tokenMint,
      approvedCluster: getModel().issuers.get(instrument.issuerId)?.solanaCluster ?? "devnet",
      observedCluster: payment.cluster,
      approvedWallet: instrument.approvedWallet,
      observedRecipient: payment.toApprovedAddress,
      canonical: payment.canonicalityStatus === "canonical",
      amountMatches: BigInt(payment.amountBaseUnits) === BigInt(instrument.purchasePriceMinor),
      hasSignedInstrument: instrument.signedDocumentSha256 !== null,
    });
    if (!verdict.ok) {
      payment.refusalReason = verdict.reasons.map((r) => `${r.code}: ${r.detail}`).join("; ");
      record({
        actor: sessionOf(c)!.address,
        action: "payment.verified",
        issuerId: instrument.issuerId,
        instrumentId: instrument.id,
        payloadHash: payment.verificationPayloadHash,
        detail: `refused: ${verdict.reasons.map((r) => r.code).join(", ")}`,
      });
      return c.json({ error: "payment refused", code: "stamp_payment_refused", reasons: verdict.reasons }, 409);
    }

    payment.verifiedAt = now();
    payment.refusalReason = null;
    const funded = transitionInstrument(
      instrument.id,
      "FUNDED",
      sessionOf(c)!.address,
      "payment verified",
    );
    if (!funded.ok) return c.json({ error: funded.reason, code: "stamp_invalid_transition" }, 409);
    record({
      actor: sessionOf(c)!.address,
      action: "instrument.payment_verified",
      issuerId: instrument.issuerId,
      instrumentId: instrument.id,
      payloadHash: payment.verificationPayloadHash,
      detail: `verified ${payment.amountBaseUnits}`,
    });
    return c.json({ payment, instrument: funded.instrument });
  });

  /* ------------------------------------------------------------------ */
  /* Admin: notices                                                       */
  /* ------------------------------------------------------------------ */

  app.post("/admin/notices", async (c) => {
    const denied = requireReviewer(c);
    if (denied) return denied;
    const { body, error } = await readJson<{
      issuerId?: string;
      structuringEventAt?: number | string;
      expirationAt?: number | string;
      holidays?: string[];
    }>(c);
    if (error || !body?.issuerId) return badRequest(c, error ?? "issuerId is required");
    const notices = scheduleNotices({
      issuerId: body.issuerId,
      structuringEventAt:
        typeof body.structuringEventAt === "number"
          ? body.structuringEventAt
          : body.structuringEventAt
            ? Date.parse(body.structuringEventAt)
            : null,
      expirationAt:
        typeof body.expirationAt === "number"
          ? body.expirationAt
          : body.expirationAt
            ? Date.parse(body.expirationAt)
            : null,
      now: now(),
      holidays: body.holidays,
      actor: sessionOf(c)!.address,
    });
    return c.json({ notices });
  });

  app.get("/admin/notices", (c) => {
    const denied = requireReviewer(c);
    if (denied) return denied;
    return c.json({ notices: [...getModel().notices.values()] });
  });

  app.post("/admin/notices/:id/deliver", async (c) => {
    const denied = requireReviewer(c);
    if (denied) return denied;
    const { body, error } = await readJson<{
      deliveredAt?: number | string;
      evidenceUri?: string;
      evidenceHash?: string;
    }>(c);
    if (error || !body) return badRequest(c, error ?? "invalid body");
    if (!body.evidenceUri || !body.evidenceHash) {
      return badRequest(c, "a notice is only delivered with evidenceUri and evidenceHash");
    }
    const result = markNoticeDelivered({
      noticeId: c.req.param("id"),
      deliveredAt:
        typeof body.deliveredAt === "number"
          ? body.deliveredAt
          : body.deliveredAt
            ? Date.parse(body.deliveredAt)
            : now(),
      evidenceUri: body.evidenceUri,
      evidenceHash: body.evidenceHash,
      actor: sessionOf(c)!.address,
    });
    if (!result.ok) return c.json({ error: result.reason, code: "not-found" }, 404);
    return c.json({ notice: result.notice });
  });

  /* ------------------------------------------------------------------ */
  /* Admin: structuring event                                             */
  /* ------------------------------------------------------------------ */

  app.post("/admin/structuring-event/prepare", async (c) => {
    const denied = requireReviewer(c);
    if (denied) return denied;
    const { body, error } = await readJson<{
      issuerId?: string;
      metaDaoProjectRef?: string;
      totalNetworkTokens?: string;
      tokenMint?: string;
      tokenProgramId?: string;
      mintAuthorityBefore?: string | null;
      legalSupplySnapshotHash?: string;
      metaDaoApprovalRef?: string;
    }>(c);
    if (error || !body) return badRequest(c, error ?? "invalid body");
    if (!body.issuerId) return badRequest(c, "issuerId is required");
    if (!body.totalNetworkTokens || !/^[0-9]+$/.test(body.totalNetworkTokens)) {
      return badRequest(c, "totalNetworkTokens must be an integer string");
    }
    if (!body.tokenMint || !body.tokenProgramId) {
      return badRequest(c, "tokenMint and tokenProgramId are required");
    }
    if (!body.metaDaoApprovalRef) return badRequest(c, "metaDaoApprovalRef is required");
    if (!body.legalSupplySnapshotHash || !/^[0-9a-f]{64}$/i.test(body.legalSupplySnapshotHash)) {
      return badRequest(c, "legalSupplySnapshotHash must be a hex SHA-256");
    }
    const event = prepareStructuringEvent({
      issuerId: body.issuerId,
      metaDaoProjectRef: body.metaDaoProjectRef ?? getModel().issuers.get(body.issuerId)?.metaDaoProjectRef ?? "",
      totalNetworkTokens: body.totalNetworkTokens,
      tokenMint: body.tokenMint,
      tokenProgramId: body.tokenProgramId,
      mintAuthorityBefore: body.mintAuthorityBefore ?? null,
      legalSupplySnapshotHash: body.legalSupplySnapshotHash.toLowerCase(),
      metaDaoApprovalRef: body.metaDaoApprovalRef,
      actor: sessionOf(c)!.address,
    });
    return c.json({ event }, 201);
  });

  /**
   * Reconcile the structuring event against the legal snapshot.
   *
   * The gate here is the tokenomics gate: the investor reserve under the cap,
   * the team allocation inside its band, and the supply snapshot agreeing with
   * the chain. A mismatch holds the event instead of advancing it.
   */
  app.post("/admin/structuring-event/:id/reconcile", async (c) => {
    const denied = requireReviewer(c);
    if (denied) return denied;
    const { body, error } = await readJson<{
      structuringSlot?: number;
      structuringSignature?: string;
      finalityStatus?: string;
      mintAuthorityAfter?: string | null;
      observedSupply?: string;
      metaDaoConfirmed?: boolean;
    }>(c);
    if (error || !body) return badRequest(c, error ?? "invalid body");
    const event = getModel().structuringEvents.get(c.req.param("id"));
    if (!event) return c.json({ error: "not found", code: "not-found" }, 404);

    const allocations = getModel().allocations.get(event.issuerId) ?? [];
    const effectiveBps = allocations.reduce((a, s) => a + BigInt(s.effectiveProRataBps), 0n);
    const portions = allocations.reduce((a, s) => a + BigInt(s.holderPortionTokens), 0n);
    // The team allocation is a signed-manifest value, not a constant in this
    // file. It used to be `2000n` — a number from the 2026 documentation,
    // checked against itself, so the gate could never disagree with the code.
    // Absent or malformed means the band cannot be checked, and an unchecked
    // band is a refusal rather than a default.
    const teamBpsRaw = (process.env.STAMP_TEAM_ALLOCATION_BPS ?? "").trim();
    if (!/^[0-9]+$/.test(teamBpsRaw)) {
      return c.json(
        {
          error:
            "STAMP_TEAM_ALLOCATION_BPS must be set to the signed team allocation in basis points before reconciling",
          code: "stamp_team_allocation_unknown",
        },
        409,
      );
    }
    const verdict = tokenomicsGate({
      investorReserveBps: effectiveBps,
      teamAllocationBps: BigInt(teamBpsRaw),
      totalNetworkTokens: BigInt(event.totalNetworkTokens),
      investorPortionTotal: portions,
      supplySnapshotMatchesChain:
        body.observedSupply === undefined || body.observedSupply === event.totalNetworkTokens,
      metaDaoApproved: body.metaDaoConfirmed === true,
    });
    if (!verdict.ok) {
      return c.json(
        { error: "structuring event held", code: "stamp_structuring_held", reasons: verdict.reasons },
        409,
      );
    }

    event.structuringSlot = body.structuringSlot ?? event.structuringSlot;
    event.structuringSignature = body.structuringSignature ?? event.structuringSignature;
    event.finalityStatus = body.finalityStatus ?? event.finalityStatus;
    event.mintAuthorityAfter = body.mintAuthorityAfter ?? event.mintAuthorityAfter;
    event.status = "PORTIONS_RECONCILED";
    event.updatedAt = now();
    record({
      actor: sessionOf(c)!.address,
      action: "structuring.reconciled",
      issuerId: event.issuerId,
      instrumentId: null,
      payloadHash: event.legalSupplySnapshotHash,
      detail: `slot ${event.structuringSlot ?? "?"}`,
      topic: "stamp.structuring.reconciled",
      payload: { eventId: event.id },
    });
    return c.json({ event });
  });

  /* ------------------------------------------------------------------ */
  /* Admin: reconciliation                                                */
  /* ------------------------------------------------------------------ */

  app.get("/admin/reconciliation", (c) => {
    const denied = requireReviewer(c);
    if (denied) return denied;
    const issuerId = c.req.query("issuer") ?? "";
    if (!issuerId) return badRequest(c, "issuer query parameter is required");
    const report = reconciliationReport(issuerId);
    record({
      actor: sessionOf(c)!.address,
      action: "reconciliation.read",
      issuerId,
      instrumentId: null,
      detail: "read",
    });
    return c.json({ report, production: gate() });
  });

  /**
   * Two independent gate families the console runs before a launch: insider
   * lock-up parity and the IP perimeter. Both are inputs the app cannot invent,
   * so they are supplied and judged here.
   */
  app.post("/admin/gates/insider-parity", async (c) => {
    const denied = requireReviewer(c);
    if (denied) return denied;
    const { body, error } = await readJson<{ investor?: LockUpSchedule; insider?: LockUpSchedule }>(c);
    if (error || !body?.investor || !body?.insider) {
      return badRequest(c, error ?? "investor and insider schedules are required");
    }
    return c.json(insiderParity(body.investor, body.insider));
  });

  app.post("/admin/gates/ip-perimeter", async (c) => {
    const denied = requireReviewer(c);
    if (denied) return denied;
    const { body, error } = await readJson<{ issuerEntity?: string; assets?: IpAsset[] }>(c);
    if (error || !body?.issuerEntity || !Array.isArray(body.assets)) {
      return badRequest(c, error ?? "issuerEntity and assets are required");
    }
    return c.json(ipPerimeterGaps(body.assets, body.issuerEntity));
  });

  /* ------------------------------------------------------------------ */
  /* Investor                                                             */
  /* ------------------------------------------------------------------ */

  app.get("/investor/instruments", (c) => {
    const holder = investorHolder(c);
    if (holder instanceof Response) return holder;
    const instruments = [...getModel().instruments.values()].filter(
      (i) => i.holderPartyId === holder.holder.id,
    );
    return c.json({
      holder: { id: holder.holder.id, displayName: holder.holder.displayName },
      instruments: instruments.map((instrument) => ({
        instrument,
        expiration: instrumentExpiration(instrument.id, now()),
        vesting: vestingForInstrument(instrument.id),
      })),
    });
  });

  app.get("/investor/instruments/:id", (c) => {
    const holder = investorHolder(c);
    if (holder instanceof Response) return holder;
    const instrument = getModel().instruments.get(c.req.param("id"));
    // 404, not 403, for another holder's instrument: the id must not confirm
    // that anything exists.
    if (!instrument || instrument.holderPartyId !== holder.holder.id) {
      return c.json({ error: "instrument not found", code: "not-found" }, 404);
    }
    return c.json({
      instrument,
      expiration: instrumentExpiration(instrument.id, now()),
      vesting: vestingForInstrument(instrument.id),
    });
  });

  app.post("/investor/instruments/:id/delivery-request", async (c) => {
    const holder = investorHolder(c);
    if (holder instanceof Response) return holder;
    const instrument = getModel().instruments.get(c.req.param("id"));
    if (!instrument || instrument.holderPartyId !== holder.holder.id) {
      return c.json({ error: "instrument not found", code: "not-found" }, 404);
    }
    if (instrument.status !== "FUNDED" && instrument.status !== "ELIGIBLE_FOR_DELIVERY") {
      return c.json(
        { error: "instrument must be funded before a delivery request", code: "stamp_not_funded" },
        409,
      );
    }
    const { body, error } = await readJson<{
      destinationAddress?: string;
      addressNetwork?: string;
      requestDocumentSha256?: string;
      signedAt?: number | string;
    }>(c);
    if (error || !body) return badRequest(c, error ?? "invalid body");
    if (!body.destinationAddress) return badRequest(c, "destinationAddress is required");
    if (!body.requestDocumentSha256 || !/^[0-9a-f]{64}$/i.test(body.requestDocumentSha256)) {
      return badRequest(c, "requestDocumentSha256 must be a hex SHA-256 of the signed request");
    }
    // The contract's exercise window: the request is time-bounded, and a late
    // request is refused rather than silently accepted.
    const request = createDeliveryRequest({
      instrumentId: instrument.id,
      holderPartyId: holder.holder.id,
      requestDocumentSha256: body.requestDocumentSha256.toLowerCase(),
      signedAt:
        typeof body.signedAt === "number" ? body.signedAt : body.signedAt ? Date.parse(body.signedAt) : now(),
      contractualExerciseAt: now(),
      destinationAddress: body.destinationAddress,
      addressNetwork: body.addressNetwork ?? "solana",
      actor: sessionOf(c)!.address,
    });
    if (!request.ok) return c.json({ error: request.reason, code: "stamp_delivery_duplicate" }, 409);
    transitionInstrument(instrument.id, "DELIVERY_REQUESTED", sessionOf(c)!.address, "delivery requested");
    return c.json(
      { deliveryRequest: request.request, note: "manual review is required before any approval or execution" },
      201,
    );
  });

  /** Prove control of the destination address. */
  app.post("/investor/delivery-request/:id/address-proof", async (c) => {
    const holder = investorHolder(c);
    if (holder instanceof Response) return holder;
    const request = getModel().deliveryRequests.get(c.req.param("id"));
    if (!request || request.holderPartyId !== holder.holder.id) {
      return c.json({ error: "delivery request not found", code: "not-found" }, 404);
    }
    const { body, error } = await readJson<{ challengeSignature?: string }>(c);
    if (error || !body?.challengeSignature) {
      return badRequest(c, error ?? "challengeSignature is required");
    }
    request.addressChallengeSignature = body.challengeSignature;
    const result = transitionDelivery(request.id, "SIGNATURE_VERIFIED", sessionOf(c)!.address, "challenge signed");
    if (!result.ok) return c.json({ error: result.reason, code: "stamp_invalid_transition" }, 409);
    return c.json({ deliveryRequest: result.request });
  });

  app.get("/investor/delivery/:id", (c) => {
    const holder = investorHolder(c);
    if (holder instanceof Response) return holder;
    const request = getModel().deliveryRequests.get(c.req.param("id"));
    if (!request || request.holderPartyId !== holder.holder.id) {
      return c.json({ error: "delivery request not found", code: "not-found" }, 404);
    }
    return c.json({ deliveryRequest: request });
  });

  app.get("/investor/vesting/:id", (c) => {
    const holder = investorHolder(c);
    if (holder instanceof Response) return holder;
    const instrument = getModel().instruments.get(c.req.param("id"));
    if (!instrument || instrument.holderPartyId !== holder.holder.id) {
      return c.json({ error: "instrument not found", code: "not-found" }, 404);
    }
    const vesting = vestingForInstrument(instrument.id);
    if (!vesting) {
      return c.json(
        { error: "no vesting schedule exists: nothing has been delivered yet", code: "stamp_no_vesting" },
        404,
      );
    }
    return c.json({ vesting, state: vestingStateAt(vesting.schedule, now()) });
  });

  /** A pure calculator, so the portal can preview a schedule without a delivery. */
  app.post("/investor/vesting/calculate", async (c) => {
    const session = sessionOf(c);
    if (!session) return c.json({ error: "unauthenticated", code: "no-credential" }, 401);
    const { body, error } = await readJson<{ deliveredAmount?: string; months?: number }>(c);
    if (error || !body?.deliveredAmount) {
      return badRequest(c, error ?? "deliveredAmount is required");
    }
    if (!/^[0-9]+$/.test(body.deliveredAmount)) {
      return badRequest(c, "deliveredAmount must be an integer string of base units");
    }
    const months = body.months && body.months > 0 && body.months <= 60 ? body.months : 24;
    const vector = monthlyReleaseVector(BigInt(body.deliveredAmount), months).map(String);
    const sum = vector.reduce((a, b) => a + BigInt(b), 0n);
    const schedule = buildVestingSchedule({
      deliveredAmountBaseUnits: BigInt(body.deliveredAmount),
      deliveryDate: now(),
      months,
    });
    return c.json({
      vector,
      sum: sum.toString(),
      conserved: sum === BigInt(body.deliveredAmount),
      months,
      firstReleaseAt: schedule.firstReleaseAt,
      firstReleaseDate: new Date(schedule.firstReleaseAt).toISOString(),
    });
  });

  /* ------------------------------------------------------------------ */
  /* Admin: delivery approval and vesting creation                        */
  /* ------------------------------------------------------------------ */

  app.post("/admin/delivery/:id/approve", async (c) => {
    const denied = requireReviewer(c);
    if (denied) return denied;
    const request = getModel().deliveryRequests.get(c.req.param("id"));
    if (!request) return c.json({ error: "not found", code: "not-found" }, 404);
    const { body, error } = await readJson<{
      deliveredAmountBaseUnits?: string;
      chainAccountRef?: string;
      deliveryDate?: number | string;
      reviewRef?: string;
    }>(c);
    if (error || !body?.deliveredAmountBaseUnits) {
      return badRequest(c, error ?? "deliveredAmountBaseUnits is required");
    }
    if (!/^[0-9]+$/.test(body.deliveredAmountBaseUnits)) {
      return badRequest(c, "deliveredAmountBaseUnits must be an integer string");
    }
    if (!body.chainAccountRef) {
      return badRequest(c, "chainAccountRef is required: the lock-up account must be named");
    }
    if (!request.addressChallengeSignature) {
      return c.json(
        { error: "the destination address has not been proved by the holder", code: "stamp_address_unproved" },
        409,
      );
    }
    // §6: no delivery may exceed the instrument's portion less prior deliveries.
    // The portion is read from the frozen snapshot, never from this request; a
    // holder whose snapshot is missing is refused rather than treated as
    // unlimited.
    const portion = availablePortionForInstrument(request.instrumentId);
    if (!portion) {
      return c.json(
        {
          error: "no frozen allocation snapshot names this holder: the portion cannot be checked",
          code: "stamp_portion_unknown",
        },
        409,
      );
    }
    const quantity = deliveryQuantityGate({
      holderPortionTokens: portion.holderPortionTokens,
      priorDeliveredTokens: portion.priorDeliveredTokens,
      requestedTokens: BigInt(body.deliveredAmountBaseUnits),
    });
    if (!quantity.ok) {
      return c.json(
        {
          error: "the delivery exceeds the instrument's available portion",
          code: "stamp_delivery_exceeds_portion",
          reasons: quantity.reasons,
          availableTokens: portion.availableTokens.toString(),
        },
        409,
      );
    }
    // Walk the machine rather than jumping: an approval reached without the
    // address and eligibility steps is exactly the shortcut the machine exists
    // to refuse.
    for (const step of ["ADDRESS_VALIDATED", "ELIGIBILITY_RECHECKED", "APPROVED"] as const) {
      const result = transitionDelivery(request.id, step, sessionOf(c)!.address, body.reviewRef ?? step);
      if (!result.ok) return c.json({ error: result.reason, code: "stamp_invalid_transition" }, 409);
    }
    const instrument = getModel().instruments.get(request.instrumentId);
    const deliveryDate =
      typeof body.deliveryDate === "number"
        ? body.deliveryDate
        : body.deliveryDate
          ? Date.parse(body.deliveryDate)
          : now();
    const vesting = createVesting({
      instrumentId: request.instrumentId,
      deliveredAmountBaseUnits: BigInt(body.deliveredAmountBaseUnits),
      deliveryDate,
      chainAccountRef: body.chainAccountRef,
      actor: sessionOf(c)!.address,
    });
    if (instrument) {
      transitionInstrument(instrument.id, "DELIVERY_APPROVED", sessionOf(c)!.address, "delivery approved");
      transitionInstrument(instrument.id, "DELIVERED", sessionOf(c)!.address, "delivered");
      transitionInstrument(instrument.id, "VESTING_ACTIVE", sessionOf(c)!.address, "vesting active");
    }
    return c.json({ deliveryRequest: request, vesting });
  });

  /**
   * Reconcile a delivery against the chain.
   *
   * The delivery gate is the domain's: finality, destination, quantity,
   * lock-up, schedule, ledger and mint authority, all at once.
   */
  app.post("/admin/delivery/:id/reconcile", async (c) => {
    const denied = requireReviewer(c);
    if (denied) return denied;
    const request = getModel().deliveryRequests.get(c.req.param("id"));
    if (!request) return c.json({ error: "not found", code: "not-found" }, 404);
    const { body, error } = await readJson<{
      finality?: string;
      destinationAccountVerified?: boolean;
      quantityVerified?: boolean;
      lockupVerified?: boolean;
      scheduleMatchesAgreement?: boolean;
      ledgerReconciled?: boolean;
      mintAuthorityResolved?: boolean;
      observedReleasedBaseUnits?: string;
      /** When present, the chain read is performed here instead of trusted. */
      signature?: string;
      expectedMint?: string;
      expectedOwner?: string;
      expectedAmountBaseUnits?: string;
      lockupAccount?: string;
    }>(c);
    if (error || !body) return badRequest(c, error ?? "invalid body");

    // A chain fact is read, not accepted. When this host has an RPC and the
    // caller names the transaction, the verifier re-derives destination, quantity
    // and finality from the chain and the reviewer's booleans are ignored — a
    // reviewer recording "quantity verified" is a note, and a note is not a
    // measurement. Without an RPC the boilerplate path stays available and says
    // so in the response.
    let chainVerified = false;
    let chainOutcome: { ok: boolean; reasons: string[]; checks: unknown[] } | null = null;
    if (config.solanaRpc && body.signature && body.expectedMint && body.expectedOwner && body.expectedAmountBaseUnits) {
      const rpc = new HttpSolanaRpc({
        url: config.solanaRpc.url,
        cluster: config.solanaRpc.cluster,
        fetchImpl: config.solanaRpc.fetchImpl,
      });
      const vestingForCheck = vestingForInstrument(request.instrumentId);
      const outcome = await verifyOnChain(rpc, {
        expectedMint: body.expectedMint,
        destination: request.destinationAddress,
        expectedOwner: body.expectedOwner,
        expectedAmountBaseUnits: BigInt(body.expectedAmountBaseUnits),
        signature: body.signature,
        lockupAccount: body.lockupAccount ?? vestingForCheck?.chainAccountRef ?? null,
        scheduleMatchesAgreement: vestingForCheck !== null,
        ledgerAmountBaseUnits: BigInt(body.expectedAmountBaseUnits),
        mintAuthorityResolved: body.mintAuthorityResolved === true,
      });
      chainVerified = true;
      chainOutcome = { ok: outcome.ok, reasons: outcome.reasons, checks: outcome.checks };
      if (!outcome.ok) {
        return c.json(
          {
            error: "the chain does not confirm this delivery",
            code: "stamp_delivery_unverified",
            reasons: outcome.reasons,
            checks: outcome.checks,
          },
          409,
        );
      }
    }

    const verdict = chainVerified
      ? { ok: true, reasons: [] as { code: string; detail: string }[] }
      : deliveryGate({
          finality: (body.finality as never) ?? "submitted",
          destinationAccountVerified: body.destinationAccountVerified === true,
          quantityVerified: body.quantityVerified === true,
          lockupVerified: body.lockupVerified === true,
          scheduleMatchesAgreement: body.scheduleMatchesAgreement === true,
          ledgerReconciled: body.ledgerReconciled === true,
          mintAuthorityResolved: body.mintAuthorityResolved === true,
        });
    if (!verdict.ok) {
      return c.json(
        { error: "delivery not reconciled", code: "stamp_delivery_unverified", reasons: verdict.reasons },
        409,
      );
    }
    const vesting = vestingForInstrument(request.instrumentId);
    if (vesting && body.observedReleasedBaseUnits) {
      const reconciliation = reconcileVesting(vesting.schedule, BigInt(body.observedReleasedBaseUnits));
      if (!reconciliation.ok) {
        return c.json(
          { error: reconciliation.reason, code: "stamp_vesting_mismatch" },
          409,
        );
      }
    }
    // Walk the machine rather than jumping: a delivery that reaches RECONCILED
    // without passing through SUBMITTED and CONFIRMED is exactly the shortcut
    // the delivery machine exists to refuse. The gate above has already proved
    // the chain state each of these steps claims.
    let latest = request;
    for (const step of ["SUBMITTED", "CONFIRMED", "RECONCILED"] as const) {
      const moved = transitionDelivery(request.id, step, sessionOf(c)!.address, `chain ${step.toLowerCase()}`);
      if (!moved.ok) {
        // APPROVED -> SUBMITTED is the only entry point; a request already past
        // a step has nothing to redo, so a refusal here is a real conflict.
        return c.json({ error: moved.reason, code: "stamp_invalid_transition" }, 409);
      }
      latest = moved.request;
    }
    return c.json({
      deliveryRequest: latest,
      vesting,
      chainVerified,
      chainChecks: chainOutcome?.checks ?? null,
      note: chainVerified
        ? "verified against the chain by this host"
        : "no Solana RPC is configured on this host, so the reviewer's attestations were used",
    });
  });

  /* ------------------------------------------------------------------ */
  /* Audit and outbox                                                     */
  /* ------------------------------------------------------------------ */

  app.get("/admin/audit", (c) => {
    const denied = requireReviewer(c);
    if (denied) return denied;
    const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);
    return c.json({ audit: getModel().audit.slice(-limit) });
  });

  app.get("/admin/outbox", (c) => {
    const denied = requireReviewer(c);
    if (denied) return denied;
    const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);
    return c.json({ outbox: getModel().outbox.slice(-limit) });
  });

  return app;
}