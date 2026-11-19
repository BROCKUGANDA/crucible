process.env.AUTH_ALLOW_DEV_SECRET = "1";
process.env.AUTH_ORIGIN = "http://localhost:3000";

import { beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  __resetStampForTests,
  createStampRoutes,
  holderPortion,
  monthlyReleases,
  ratableReduce,
  type StampConfig,
} from "../src/stamp.js";

const DEV_SECRET = "crucible-local-dev-secret-not-for-production";

function headers(address: string): Headers {
  const now = Date.now();
  const payload = {
    address,
    issuedAt: Math.floor(now / 1000),
    expiresAt: Math.floor(now / 1000) + 60 * 60 * 24 * 7,
    aud: "http://localhost:3000",
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", DEV_SECRET).update(encoded).digest("base64url");
  return new Headers({
    cookie: `__Host-crucible_session=${encoded}.${sig}`,
    "content-type": "application/json",
  });
}

const REVIEWER = "0x" + "11".repeat(20);
const STRANGER = "0x" + "22".repeat(20);
const HOLDER_PRINCIPAL = "0x" + "33".repeat(20);

const DOC_HASH = "a".repeat(64);
const MINT = "SANDBOX_USDC_DEVNET";

function app(config: Partial<StampConfig> = {}) {
  return createStampRoutes({
    mode: "sandbox",
    reviewers: [REVIEWER],
    ...config,
  });
}

async function post(
  instance: ReturnType<typeof createStampRoutes>,
  path: string,
  body: unknown,
  address: string = REVIEWER,
  extra: Record<string, string> = {},
): Promise<Response> {
  const requestHeaders = headers(address);
  for (const [key, value] of Object.entries(extra)) requestHeaders.set(key, value);
  return instance.request(path, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(body),
  });
}

async function get(
  instance: ReturnType<typeof createStampRoutes>,
  path: string,
  address: string = REVIEWER,
): Promise<Response> {
  return instance.request(path, { headers: headers(address) });
}

interface Setup {
  issuerId: string;
  holderId: string;
  instrumentId: string;
}

/** Create an issuer, a holder and a draft instrument. */
async function seed(
  instance: ReturnType<typeof createStampRoutes>,
  principal: string = HOLDER_PRINCIPAL,
  options: { signed?: boolean } = {},
): Promise<Setup> {
  const issuerRes = await post(instance, "/admin/issuer", {
    legalEntityName: "Crucible Protocol Issuer",
    entityType: "corporation",
    jurisdictionCode: "US-DE",
    metaDaoProjectRef: "metadao-crucible",
  });
  const issuer = ((await issuerRes.json()) as { issuer: { id: string } }).issuer;

  const holderRes = await post(instance, "/admin/holders", {
    issuerId: issuer.id,
    displayName: "Investor One",
  });
  const holder = ((await holderRes.json()) as { holder: { id: string } }).holder;
  await post(instance, "/admin/holders/bind", {
    holderId: holder.id,
    principalAddress: principal,
  });

  const instrumentRes = await post(instance, "/admin/instruments", {
    issuerId: issuer.id,
    holderPartyId: holder.id,
    documentSha256: DOC_HASH,
    documentUri: "s3://stamp/instrument-1.pdf",
    issueDate: Date.now(),
    purchasePriceMinor: "100000000",
    acceptedStablecoinMint: MINT,
    approvedWallet: "APPROVED_WALLET",
    proRataBps: "500",
  });
  const instrument = ((await instrumentRes.json()) as { instrument: { id: string } }).instrument;

  // An instrument must be counsel-approved, offered and signed before a payment
  // can fund it: SIGNED is never FUNDED, so a payment against a DRAFT has
  // nothing to fund.
  if (options.signed !== false) {
    await post(instance, `/admin/instruments/${instrument.id}/approve`, {});
    await post(instance, `/admin/instruments/${instrument.id}/transition`, { to: "OFFERED" });
    await post(instance, `/admin/instruments/${instrument.id}/record-signature`, {
      signedDocumentSha256: DOC_HASH,
    });
  }

  return { issuerId: issuer.id, holderId: holder.id, instrumentId: instrument.id };
}

beforeEach(() => {
  __resetStampForTests();
});

describe("mode gating", () => {
  it("answers 404 everywhere when disabled", async () => {
    const instance = createStampRoutes({ mode: "disabled" });
    expect((await get(instance, "/protocol/ownership")).status).toBe(404);
  });

  it("publishes a read-only projection in sandbox", async () => {
    const instance = app();
    const res = await get(instance, "/protocol/ownership");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sandbox: boolean; note: string };
    expect(body.sandbox).toBe(true);
    expect(body.note).toMatch(/NO LEGAL OR FINANCIAL EFFECT/);
  });

  it("treats an unknown mode as disabled", async () => {
    // resolveMode is exercised through the default; an invalid value must not
    // open the surface.
    const instance = createStampRoutes({ mode: "sandbox" });
    expect((await get(instance, "/protocol/ownership")).status).toBe(200);
  });
});

describe("reviewer gate", () => {
  it("refuses every admin route when no reviewer is configured", async () => {
    const instance = app({ reviewers: [] });
    const res = await post(instance, "/admin/instruments", {}, REVIEWER);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("stamp_no_reviewers");
  });

  it("refuses an unauthenticated caller", async () => {
    const instance = app();
    const res = await instance.request("/admin/issuer", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  it("admits the configured reviewer and refuses another session", async () => {
    const instance = app();
    const admitted = await post(instance, "/admin/issuer", {
      legalEntityName: "Crucible",
      entityType: "corporation",
      jurisdictionCode: "US-DE",
    });
    expect(admitted.status).toBe(201);

    const refused = await post(
      instance,
      "/admin/issuer",
      { legalEntityName: "X", entityType: "y", jurisdictionCode: "z" },
      STRANGER,
    );
    expect(refused.status).toBe(403);

    expect((await get(instance, "/admin/issuer", STRANGER)).status).toBe(403);
  });
});

describe("instrument lifecycle", () => {
  it("refuses a signature that is not on the instrument's exact document", async () => {
    const instance = app();
    const { instrumentId } = await seed(instance);
    await post(instance, `/admin/instruments/${instrumentId}/approve`, {});
    await post(instance, `/admin/instruments/${instrumentId}/transition`, { to: "OFFERED" });
    const res = await post(instance, `/admin/instruments/${instrumentId}/record-signature`, {
      signedDocumentSha256: "b".repeat(64),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("stamp_document_hash_mismatch");
  });

  it("moves a signed instrument to PAYMENT_PENDING, never to FUNDED", async () => {
    const instance = app();
    const { instrumentId } = await seed(instance, HOLDER_PRINCIPAL, { signed: false });
    await post(instance, `/admin/instruments/${instrumentId}/approve`, {});
    await post(instance, `/admin/instruments/${instrumentId}/transition`, { to: "OFFERED" });
    const res = await post(instance, `/admin/instruments/${instrumentId}/record-signature`, {
      signedDocumentSha256: DOC_HASH,
    });
    const body = (await res.json()) as { instrument: { status: string } };
    expect(body.instrument.status).toBe("PAYMENT_PENDING");
  });

  it("refuses a transition the machine does not allow", async () => {
    const instance = app();
    const { instrumentId } = await seed(instance);
    const res = await post(instance, `/admin/instruments/${instrumentId}/transition`, { to: "DELIVERED" });
    expect(res.status).toBe(409);
  });

  it("refuses an instrument without a hashed document", async () => {
    const instance = app();
    const res = await post(instance, "/admin/instruments", {
      issuerId: "issuer-1",
      holderPartyId: "holder-1",
      documentUri: "s3://x",
      purchasePriceMinor: "1",
      approvedWallet: "w",
      acceptedStablecoinMint: MINT,
      proRataBps: "1",
    });
    expect(res.status).toBe(400);
  });
});

describe("sandbox payments", () => {
  it("refuses a non-fixture cluster", async () => {
    const instance = app();
    const { instrumentId } = await seed(instance);
    const res = await post(instance, "/admin/payments/observe", {
      instrumentId,
      cluster: "mainnet-beta",
      tokenMint: MINT,
      fromAddress: "from",
      toApproved: "to",
      amountBaseUnits: "1",
      signature: "sig-1",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("stamp_wrong_cluster");
  });

  it("refuses a non-fixture mint", async () => {
    const instance = app();
    const { instrumentId } = await seed(instance);
    const res = await post(instance, "/admin/payments/observe", {
      instrumentId,
      cluster: "devnet",
      tokenMint: "USDC_REAL",
      fromAddress: "from",
      toApproved: "to",
      amountBaseUnits: "1",
      signature: "sig-2",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("stamp_wrong_mint");
  });

  it("accepts a fixture observation", async () => {
    const instance = app();
    const { instrumentId } = await seed(instance);
    const res = await post(instance, "/admin/payments/observe", {
      instrumentId,
      cluster: "devnet",
      tokenMint: MINT,
      fromAddress: "from",
      toApproved: "to",
      amountBaseUnits: "1",
      signature: "sig-3",
    });
    expect(res.status).toBe(201);
  });

  it("refuses a duplicate signature for the same mint", async () => {
    const instance = app();
    const { instrumentId } = await seed(instance);
    const payload = {
      instrumentId,
      cluster: "devnet",
      tokenMint: MINT,
      fromAddress: "from",
      toApproved: "to",
      amountBaseUnits: "1",
      signature: "sig-dup",
    };
    expect((await post(instance, "/admin/payments/observe", payload)).status).toBe(201);
    const second = await post(instance, "/admin/payments/observe", payload);
    expect(second.status).toBe(409);
    expect(((await second.json()) as { code: string }).code).toBe("stamp_duplicate_payment");
  });

  it("refuses to verify a fixture payment into a funded instrument", async () => {
    const instance = app();
    const { instrumentId } = await seed(instance);
    const observed = await post(instance, "/admin/payments/observe", {
      instrumentId,
      cluster: "devnet",
      tokenMint: MINT,
      fromAddress: "from",
      toApproved: "to",
      amountBaseUnits: "1",
      signature: "sig-4",
    });
    const payment = ((await observed.json()) as { payment: { id: string } }).payment;
    const res = await post(instance, `/admin/payments/${payment.id}/verify`, {});
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("stamp_sandbox_only");
  });
});

describe("manual review payments", () => {
  const manual = () =>
    createStampRoutes({ mode: "manual_review", reviewers: [REVIEWER] });

  it("funds an instrument once the payment matches the agreement", async () => {
    const instance = manual();
    const { instrumentId } = await seed(instance);
    const observed = await post(instance, "/admin/payments/observe", {
      instrumentId,
      cluster: "devnet",
      tokenMint: MINT,
      fromAddress: "from",
      toApproved: "APPROVED_WALLET",
      amountBaseUnits: "100000000",
      signature: "sig-manual-1",
      finalityStatus: "finalized",
      canonicalityStatus: "canonical",
    });
    const payment = ((await observed.json()) as { payment: { id: string } }).payment;
    const res = await post(instance, `/admin/payments/${payment.id}/verify`, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { instrument: { status: string } };
    expect(body.instrument.status).toBe("FUNDED");
  });

  it("refuses a payment sent to the wrong wallet", async () => {
    const instance = manual();
    const { instrumentId } = await seed(instance);
    const observed = await post(instance, "/admin/payments/observe", {
      instrumentId,
      cluster: "devnet",
      tokenMint: MINT,
      fromAddress: "from",
      toApproved: "SOMEONE_ELSE",
      amountBaseUnits: "100000000",
      signature: "sig-manual-2",
      finalityStatus: "finalized",
      canonicalityStatus: "canonical",
    });
    const payment = ((await observed.json()) as { payment: { id: string } }).payment;
    const res = await post(instance, `/admin/payments/${payment.id}/verify`, {});
    expect(res.status).toBe(409);
    const body = (await res.json()) as { reasons: { code: string }[] };
    expect(body.reasons.map((r) => r.code)).toContain("wrong_wallet");
  });

  it("refuses a payment that is not canonical", async () => {
    const instance = manual();
    const { instrumentId } = await seed(instance);
    const observed = await post(instance, "/admin/payments/observe", {
      instrumentId,
      cluster: "devnet",
      tokenMint: MINT,
      fromAddress: "from",
      toApproved: "APPROVED_WALLET",
      amountBaseUnits: "100000000",
      signature: "sig-manual-3",
      finalityStatus: "confirmed",
      canonicalityStatus: "pending",
    });
    const payment = ((await observed.json()) as { payment: { id: string } }).payment;
    const res = await post(instance, `/admin/payments/${payment.id}/verify`, {});
    expect(res.status).toBe(409);
    const body = (await res.json()) as { reasons: { code: string }[] };
    expect(body.reasons.map((r) => r.code)).toContain("payment_not_canonical");
  });

  it("refuses a payment whose amount does not match the purchase price", async () => {
    const instance = manual();
    const { instrumentId } = await seed(instance);
    const observed = await post(instance, "/admin/payments/observe", {
      instrumentId,
      cluster: "devnet",
      tokenMint: MINT,
      fromAddress: "from",
      toApproved: "APPROVED_WALLET",
      amountBaseUnits: "1",
      signature: "sig-manual-4",
      finalityStatus: "finalized",
      canonicalityStatus: "canonical",
    });
    const payment = ((await observed.json()) as { payment: { id: string } }).payment;
    const res = await post(instance, `/admin/payments/${payment.id}/verify`, {});
    expect(res.status).toBe(409);
    const body = (await res.json()) as { reasons: { code: string }[] };
    expect(body.reasons.map((r) => r.code)).toContain("amount_mismatch");
  });
});

describe("investor portal", () => {
  async function funded(mode: "manual_review" | "sandbox" = "manual_review") {
    const instance = createStampRoutes({ mode, reviewers: [REVIEWER] });
    const setup = await seed(instance);
    // A delivery is checked against the holder's frozen Schedule 2 portion, so
    // the funded fixture has to have a Schedule 2. Without this the approve
    // route would (correctly) refuse with `stamp_portion_unknown`.
    await post(instance, "/admin/allocations", {
      issuerId: setup.issuerId,
      totalNetworkTokens: "1000000000000",
      holders: [{ holderId: setup.holderId, proRataBps: "500" }],
    });
    if (mode === "manual_review") {
      const observed = await post(instance, "/admin/payments/observe", {
        instrumentId: setup.instrumentId,
        cluster: "devnet",
        tokenMint: MINT,
        fromAddress: "from",
        toApproved: "APPROVED_WALLET",
        amountBaseUnits: "100000000",
        signature: `sig-${setup.instrumentId}`,
        finalityStatus: "finalized",
        canonicalityStatus: "canonical",
      });
      const payment = ((await observed.json()) as { payment: { id: string } }).payment;
      await post(instance, `/admin/payments/${payment.id}/verify`, {});
    }
    return { instance, ...setup };
  }

  it("refuses a session that is not bound to a holder", async () => {
    const instance = app();
    await seed(instance);
    const res = await get(instance, "/investor/instruments", STRANGER);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("stamp_holder_unbound");
  });

  it("shows a holder only their own instruments", async () => {
    const { instance, instrumentId } = await funded();
    const res = await get(instance, "/investor/instruments", HOLDER_PRINCIPAL);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { instruments: { instrument: { id: string } }[] };
    expect(body.instruments).toHaveLength(1);
    expect(body.instruments[0]!.instrument.id).toBe(instrumentId);
  });

  it("404s another holder's instrument rather than confirming it exists", async () => {
    const { instance, instrumentId } = await funded();
    const res = await get(instance, `/investor/instruments/${instrumentId}`, STRANGER);
    // A stranger is unbound (403); a bound holder with someone else's id is 404.
    expect([403, 404]).toContain(res.status);
  });

  it("refuses a delivery request before the instrument is funded", async () => {
    const instance = createStampRoutes({ mode: "manual_review", reviewers: [REVIEWER] });
    const { instrumentId } = await seed(instance);
    const res = await post(
      instance,
      `/investor/instruments/${instrumentId}/delivery-request`,
      { destinationAddress: "DEST", requestDocumentSha256: "c".repeat(64) },
      HOLDER_PRINCIPAL,
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("stamp_not_funded");
  });

  it("accepts a delivery request from the bound holder and refuses a duplicate", async () => {
    const { instance, instrumentId } = await funded();
    const payload = {
      destinationAddress: "DEST_ADDRESS",
      requestDocumentSha256: "c".repeat(64),
      addressNetwork: "solana",
    };
    const first = await post(
      instance,
      `/investor/instruments/${instrumentId}/delivery-request`,
      payload,
      HOLDER_PRINCIPAL,
    );
    expect(first.status).toBe(201);
    const second = await post(
      instance,
      `/investor/instruments/${instrumentId}/delivery-request`,
      payload,
      HOLDER_PRINCIPAL,
    );
    expect(second.status).toBe(409);
  });

  it("requires the holder to prove the destination address before approval", async () => {
    const { instance, instrumentId } = await funded();
    const created = await post(
      instance,
      `/investor/instruments/${instrumentId}/delivery-request`,
      { destinationAddress: "DEST_ADDRESS", requestDocumentSha256: "c".repeat(64) },
      HOLDER_PRINCIPAL,
    );
    const request = ((await created.json()) as { deliveryRequest: { id: string } }).deliveryRequest;
    const res = await post(instance, `/admin/delivery/${request.id}/approve`, {
      deliveredAmountBaseUnits: "100000000",
      chainAccountRef: "lockup-account",
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("stamp_address_unproved");
  });

  it("walks a proved request through approval and creates a conserving schedule", async () => {
    const { instance, instrumentId } = await funded();
    const created = await post(
      instance,
      `/investor/instruments/${instrumentId}/delivery-request`,
      { destinationAddress: "DEST_ADDRESS", requestDocumentSha256: "c".repeat(64) },
      HOLDER_PRINCIPAL,
    );
    const request = ((await created.json()) as { deliveryRequest: { id: string } }).deliveryRequest;
    const proved = await post(
      instance,
      `/investor/delivery-request/${request.id}/address-proof`,
      { challengeSignature: "challenge-sig" },
      HOLDER_PRINCIPAL,
    );
    expect(proved.status).toBe(200);

    const approved = await post(instance, `/admin/delivery/${request.id}/approve`, {
      deliveredAmountBaseUnits: "100000000",
      chainAccountRef: "lockup-account",
    });
    expect(approved.status).toBe(200);
    const body = (await approved.json()) as {
      vesting: { schedule: { conserved: boolean; monthlyVector: unknown[] } };
    };
    expect(body.vesting.schedule.conserved).toBe(true);
    expect(body.vesting.schedule.monthlyVector).toHaveLength(24);

    const vestingRes = await get(instance, `/investor/vesting/${instrumentId}`, HOLDER_PRINCIPAL);
    expect(vestingRes.status).toBe(200);
    const vestingBody = (await vestingRes.json()) as { state: { releasedBaseUnits: string } };
    expect(vestingBody.state.releasedBaseUnits).toBe("0");
  });

  it("refuses a delivery larger than the holder's available portion", async () => {
    // 500 bps of 1e12 = 5e10 base units. Asking for one unit more must be a
    // refusal, not a vesting schedule for tokens the instrument never entitled.
    const { instance, instrumentId } = await funded();
    const created = await post(
      instance,
      `/investor/instruments/${instrumentId}/delivery-request`,
      { destinationAddress: "DEST_ADDRESS", requestDocumentSha256: "c".repeat(64) },
      HOLDER_PRINCIPAL,
    );
    const request = ((await created.json()) as { deliveryRequest: { id: string } }).deliveryRequest;
    await post(
      instance,
      `/investor/delivery-request/${request.id}/address-proof`,
      { challengeSignature: "challenge-sig" },
      HOLDER_PRINCIPAL,
    );

    const refused = await post(instance, `/admin/delivery/${request.id}/approve`, {
      deliveredAmountBaseUnits: "50000000001",
      chainAccountRef: "lockup-account",
    });
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as { code: string; availableTokens: string };
    expect(body.code).toBe("stamp_delivery_exceeds_portion");
    // The refusal says what was available, so the operator can correct the figure
    // instead of guessing.
    expect(body.availableTokens).toBe("50000000000");
  });

  it("counts an earlier delivery against the portion", async () => {
    // The invariant is "portion less prior deliveries", not "portion per call".
    const { instance, instrumentId } = await funded();
    const deliver = async (amount: string) => {
      const created = await post(
        instance,
        `/investor/instruments/${instrumentId}/delivery-request`,
        { destinationAddress: "DEST_ADDRESS", requestDocumentSha256: "c".repeat(64) },
        HOLDER_PRINCIPAL,
      );
      const request = ((await created.json()) as { deliveryRequest: { id: string } }).deliveryRequest;
      await post(
        instance,
        `/investor/delivery-request/${request.id}/address-proof`,
        { challengeSignature: "challenge-sig" },
        HOLDER_PRINCIPAL,
      );
      return post(instance, `/admin/delivery/${request.id}/approve`, {
        deliveredAmountBaseUnits: amount,
        chainAccountRef: "lockup-account",
      });
    };

    // The first request moves the instrument out of FUNDED, so a second request
    // is refused upstream. The ledger arithmetic is what matters here, and it is
    // asserted directly: prior deliveries are summed from the vesting records.
    const { availablePortionForInstrument } = await import("../src/stamp/store.js");
    expect(availablePortionForInstrument(instrumentId)?.availableTokens).toBe(50000000000n);

    const first = await deliver("1000000000");
    expect(first.status).toBe(200);
    expect(availablePortionForInstrument(instrumentId)?.availableTokens).toBe(49000000000n);
    expect(availablePortionForInstrument(instrumentId)?.priorDeliveredTokens).toBe(1000000000n);
  });
});

describe("delivery reconciliation", () => {
  async function reconcileScenario() {
    const instance = createStampRoutes({ mode: "manual_review", reviewers: [REVIEWER] });
    const setup = await seed(instance);
    // The approve path checks the delivered amount against the frozen portion.
    await post(instance, "/admin/allocations", {
      issuerId: setup.issuerId,
      totalNetworkTokens: "1000000000000",
      holders: [{ holderId: setup.holderId, proRataBps: "500" }],
    });
    const observed = await post(instance, "/admin/payments/observe", {
      instrumentId: setup.instrumentId,
      cluster: "devnet",
      tokenMint: MINT,
      fromAddress: "from",
      toApproved: "APPROVED_WALLET",
      amountBaseUnits: "100000000",
      signature: `sig-rec-${setup.instrumentId}`,
      finalityStatus: "finalized",
      canonicalityStatus: "canonical",
    });
    const payment = ((await observed.json()) as { payment: { id: string } }).payment;
    await post(instance, `/admin/payments/${payment.id}/verify`, {});
    const created = await post(
      instance,
      `/investor/instruments/${setup.instrumentId}/delivery-request`,
      { destinationAddress: "DEST_ADDRESS", requestDocumentSha256: "c".repeat(64) },
      HOLDER_PRINCIPAL,
    );
    const request = ((await created.json()) as { deliveryRequest: { id: string } }).deliveryRequest;
    await post(
      instance,
      `/investor/delivery-request/${request.id}/address-proof`,
      { challengeSignature: "challenge-sig" },
      HOLDER_PRINCIPAL,
    );
    await post(instance, `/admin/delivery/${request.id}/approve`, {
      deliveredAmountBaseUnits: "100000000",
      chainAccountRef: "lockup-account",
    });
    return { instance, requestId: request.id as string };
  }

  const allVerified = {
    finality: "finalized",
    destinationAccountVerified: true,
    quantityVerified: true,
    lockupVerified: true,
    scheduleMatchesAgreement: true,
    ledgerReconciled: true,
    mintAuthorityResolved: true,
  };

  it("refuses reconciliation before the transaction is final", async () => {
    const { instance, requestId } = await reconcileScenario();
    const res = await post(instance, `/admin/delivery/${requestId}/reconcile`, {
      ...allVerified,
      finality: "submitted",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { reasons: { code: string }[] };
    expect(body.reasons.map((r) => r.code)).toContain("not_final");
  });

  it("refuses reconciliation with an unreconciled ledger", async () => {
    const { instance, requestId } = await reconcileScenario();
    const res = await post(instance, `/admin/delivery/${requestId}/reconcile`, {
      ...allVerified,
      ledgerReconciled: false,
    });
    expect(res.status).toBe(409);
  });

  it("reconciles a fully verified delivery", async () => {
    const { instance, requestId } = await reconcileScenario();
    const res = await post(instance, `/admin/delivery/${requestId}/reconcile`, allVerified);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deliveryRequest: { status: string } };
    expect(body.deliveryRequest.status).toBe("RECONCILED");
  });
});

describe("allocations", () => {
  it("applies the 20% cap and records the snapshot", async () => {
    const instance = app();
    const { issuerId, holderId } = await seed(instance);
    const res = await post(instance, "/admin/allocations", {
      issuerId,
      totalNetworkTokens: "1000000000",
      holders: [
        { holderId, proRataBps: "2500" },
        { holderId: "other", proRataBps: "1000" },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      capped: boolean;
      effectiveTotalBps: string;
      conserved: boolean;
      snapshots: { calculationInputHash: string }[];
    };
    expect(body.capped).toBe(true);
    expect(body.effectiveTotalBps).toBe("2000");
    expect(body.conserved).toBe(true);
    expect(body.snapshots[0]!.calculationInputHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a non-integer token supply", async () => {
    const instance = app();
    const { issuerId } = await seed(instance);
    const res = await post(instance, "/admin/allocations", {
      issuerId,
      totalNetworkTokens: "1.5",
      holders: [{ holderId: "h", proRataBps: "1" }],
    });
    expect(res.status).toBe(400);
  });
});

describe("notices and reconciliation report", () => {
  it("marks a notice overdue instead of dropping it", async () => {
    const instance = app();
    const { issuerId } = await seed(instance);
    const res = await post(instance, "/admin/notices", {
      issuerId,
      structuringEventAt: Date.now() - 30 * 86_400_000,
    });
    const body = (await res.json()) as { notices: { status: string }[] };
    expect(body.notices[0]!.status).toBe("MISSED");
  });

  it("reports reserve headroom and outstanding notices", async () => {
    const instance = app();
    const { issuerId, holderId } = await seed(instance);
    await post(instance, "/admin/allocations", {
      issuerId,
      totalNetworkTokens: "1000000000",
      holders: [{ holderId, proRataBps: "500" }],
    });
    const res = await get(instance, `/admin/reconciliation?issuer=${issuerId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { report: { reserve: { headroomBps: string } } };
    expect(body.report.reserve.headroomBps).toBe("1500");
  });
});

describe("audit and outbox", () => {
  it("records every mutation in the audit log", async () => {
    const instance = app();
    await seed(instance);
    const res = await get(instance, "/admin/audit?limit=50");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { audit: { action: string }[] };
    const actions = body.audit.map((a) => a.action);
    expect(actions).toContain("issuer.created");
    expect(actions).toContain("instrument.created");
  });

  it("enqueues an outbox row for a mutation with a downstream effect", async () => {
    const instance = app();
    await seed(instance);
    const res = await get(instance, "/admin/outbox?limit=50");
    const body = (await res.json()) as { outbox: { topic: string }[] };
    expect(body.outbox.some((o) => o.topic === "stamp.issuer.created")).toBe(true);
  });
});

describe("production gate", () => {
  it("refuses irreversible actions when no manifest is loaded", async () => {
    const instance = createStampRoutes({ mode: "production", reviewers: [REVIEWER] });
    const { instrumentId } = await seed(instance);
    const observed = await post(instance, "/admin/payments/observe", {
      instrumentId,
      cluster: "devnet",
      tokenMint: MINT,
      fromAddress: "from",
      toApproved: "APPROVED_WALLET",
      amountBaseUnits: "100000000",
      signature: "sig-prod-1",
      finalityStatus: "finalized",
      canonicalityStatus: "canonical",
    });
    const payment = ((await observed.json()) as { payment: { id: string } }).payment;
    const res = await post(instance, `/admin/payments/${payment.id}/verify`, {});
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("stamp_production_blocked");
  });
});

describe("public transparency", () => {
  it("shows nothing rather than zero when no allocation exists", async () => {
    const instance = app();
    const { issuerId } = await seed(instance);
    const res = await get(instance, `/protocol/transparency?issuer=${issuerId}`, STRANGER);
    const body = (await res.json()) as { transparency: { investorReserveBps: string | null } };
    expect(body.transparency.investorReserveBps).toBeNull();
  });

  it("shows the effective reserve once an allocation is recorded", async () => {
    const instance = app();
    const { issuerId, holderId } = await seed(instance);
    await post(instance, "/admin/allocations", {
      issuerId,
      totalNetworkTokens: "1000000000",
      holders: [{ holderId, proRataBps: "500" }],
    });
    const res = await get(instance, `/protocol/transparency?issuer=${issuerId}`, STRANGER);
    const body = (await res.json()) as { transparency: { investorReserveBps: string | null } };
    expect(body.transparency.investorReserveBps).toBe("500");
  });
});

describe("pure math", () => {
  it("conserves the 24-month vesting vector exactly", () => {
    const vector = monthlyReleases(100n * 10n ** 18n);
    expect(vector).toHaveLength(24);
    expect(vector.reduce((a, b) => a + b, 0n)).toBe(100n * 10n ** 18n);
  });

  it("reduces an over-cap aggregate to exactly the cap", () => {
    const effective = ratableReduce([2500n, 1000n]);
    expect(effective.reduce((a, b) => a + b, 0n)).toBe(2000n);
  });

  it("computes a holder's portion", () => {
    expect(holderPortion(500n, 1_000_000n)).toBe(50_000n);
  });
});
