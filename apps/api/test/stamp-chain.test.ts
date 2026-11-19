process.env.AUTH_ALLOW_DEV_SECRET = "1";
process.env.AUTH_ORIGIN = "http://localhost:3000";

import { beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { base58Encode } from "@crucible/stamp-solana";
import { __resetStampForTests, createStampRoutes } from "../src/stamp.js";

/**
 * The delivery reconciliation route, with a chain behind it.
 *
 * These tests exist for one reason: a reviewer recording "quantity verified" is
 * a note, and a note is not a measurement. When the host has an RPC, the route
 * re-derives the chain facts and ignores the booleans — so the tests below feed
 * it a chain that disagrees with the caller and require a refusal.
 */

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
const HOLDER_PRINCIPAL = "0x" + "33".repeat(20);
const DOC_HASH = "a".repeat(64);
const MINT_ADDRESS = base58Encode(new Uint8Array(32).fill(0x11));
const OWNER = base58Encode(new Uint8Array(32).fill(0x22));

let instance: ReturnType<typeof createStampRoutes>;
let rpcCalls: string[];

function fakeRpc(options: { finality?: string; amount?: bigint } = {}) {
  rpcCalls = [];
  const mintBytes = new Uint8Array(82);
  mintBytes[44] = 6;
  mintBytes[45] = 1;
  new DataView(mintBytes.buffer).setBigUint64(36, 1_000_000n, true);

  const tokenBytes = new Uint8Array(165);
  tokenBytes.fill(0x11, 0, 32); // mint
  tokenBytes.fill(0x22, 32, 64); // owner
  new DataView(tokenBytes.buffer).setBigUint64(64, options.amount ?? 100_000_000n, true);
  tokenBytes[108] = 1; // initialized

  return (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { method: string; params: unknown[] };
    rpcCalls.push(body.method);
    const result = ((): unknown => {
      if (body.method === "getAccountInfo") {
        const address = String((body.params as string[])[0]);
        if (address === MINT_ADDRESS) {
          return {
            value: {
              data: [Buffer.from(mintBytes).toString("base64"), "base64"],
              owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
              lamports: 1,
              executable: false,
              slot: 10,
            },
          };
        }
        return {
          value: {
            data: [Buffer.from(tokenBytes).toString("base64"), "base64"],
            owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
            lamports: 2_039_280,
            executable: false,
            slot: 10,
          },
        };
      }
      if (body.method === "getSignatureStatuses") {
        return {
          value: [
            {
              slot: 10,
              err: null,
              confirmations: null,
              confirmationStatus: options.finality ?? "finalized",
            },
          ],
        };
      }
      return 0;
    })();
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

async function post(path: string, body: unknown, address = REVIEWER): Promise<Response> {
  return instance.request(path, {
    method: "POST",
    headers: headers(address),
    body: JSON.stringify(body),
  });
}

/** An instrument funded through manual review, with a proved delivery request. */
async function delivered(): Promise<string> {
  const issuer = (await (
    await post("/admin/issuer", {
      legalEntityName: "Crucible Protocol Issuer",
      entityType: "corporation",
      jurisdictionCode: "US-DE",
    })
  ).json()) as { issuer: { id: string } };
  const holder = (await (
    await post("/admin/holders", { issuerId: issuer.issuer.id, displayName: "Investor One" })
  ).json()) as { holder: { id: string } };
  await post("/admin/holders/bind", {
    holderId: holder.holder.id,
    principalAddress: HOLDER_PRINCIPAL,
  });
  // The delivery amount is checked against the frozen Schedule 2 portion.
  await post("/admin/allocations", {
    issuerId: issuer.issuer.id,
    totalNetworkTokens: "1000000000000",
    holders: [{ holderId: holder.holder.id, proRataBps: "500" }],
  });
  const instrument = (await (
    await post("/admin/instruments", {
      issuerId: issuer.issuer.id,
      holderPartyId: holder.holder.id,
      documentSha256: DOC_HASH,
      documentUri: "s3://stamp/instrument.pdf",
      issueDate: Date.now(),
      purchasePriceMinor: "100000000",
      acceptedStablecoinMint: MINT_ADDRESS,
      approvedWallet: "APPROVED_WALLET",
      proRataBps: "500",
    })
  ).json()) as { instrument: { id: string } };

  await post(`/admin/instruments/${instrument.instrument.id}/approve`, {});
  await post(`/admin/instruments/${instrument.instrument.id}/transition`, { to: "OFFERED" });
  await post(`/admin/instruments/${instrument.instrument.id}/record-signature`, {
    signedDocumentSha256: DOC_HASH,
  });

  const payment = (await (
    await post("/admin/payments/observe", {
      instrumentId: instrument.instrument.id,
      cluster: "devnet",
      tokenMint: MINT_ADDRESS,
      fromAddress: "from",
      toApproved: "APPROVED_WALLET",
      amountBaseUnits: "100000000",
      signature: "payment-signature",
      finalityStatus: "finalized",
      canonicalityStatus: "canonical",
    })
  ).json()) as { payment: { id: string } };
  await post(`/admin/payments/${payment.payment.id}/verify`, {});

  const request = (await (
    await post(
      `/investor/instruments/${instrument.instrument.id}/delivery-request`,
      { destinationAddress: "DEST_ADDRESS", requestDocumentSha256: "c".repeat(64) },
      HOLDER_PRINCIPAL,
    )
  ).json()) as { deliveryRequest: { id: string } };
  await post(
    `/investor/delivery-request/${request.deliveryRequest.id}/address-proof`,
    { challengeSignature: "challenge-signature" },
    HOLDER_PRINCIPAL,
  );
  await post(`/admin/delivery/${request.deliveryRequest.id}/approve`, {
    deliveredAmountBaseUnits: "100000000",
    chainAccountRef: "lockup-account",
  });
  return request.deliveryRequest.id;
}

function makeApp(rpcOptions: { finality?: string; amount?: bigint } = {}) {
  return createStampRoutes({
    mode: "manual_review",
    reviewers: [REVIEWER],
    solanaRpc: { url: "https://rpc.test", cluster: "devnet", fetchImpl: fakeRpc(rpcOptions) },
  });
}

beforeEach(() => {
  __resetStampForTests();
});

describe("chain-verified delivery reconciliation", () => {
  it("re-derives the chain facts instead of trusting the reviewer's booleans", async () => {
    instance = makeApp();
    const requestId = await delivered();
    const res = await post(`/admin/delivery/${requestId}/reconcile`, {
      signature: "delivery-signature",
      expectedMint: MINT_ADDRESS,
      expectedOwner: OWNER,
      expectedAmountBaseUnits: "100000000",
      mintAuthorityResolved: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      chainVerified: boolean;
      deliveryRequest: { status: string };
      chainChecks: unknown[];
    };
    expect(body.chainVerified).toBe(true);
    expect(body.deliveryRequest.status).toBe("RECONCILED");
    // The verifier actually read the chain, rather than reporting from memory.
    expect(rpcCalls).toContain("getAccountInfo");
    expect(rpcCalls).toContain("getSignatureStatuses");
    expect(body.chainChecks.length).toBeGreaterThan(0);
  });

  it("refuses a delivery the chain does not confirm, whatever the caller asserts", async () => {
    instance = makeApp();
    const requestId = await delivered();
    const res = await post(`/admin/delivery/${requestId}/reconcile`, {
      signature: "delivery-signature",
      expectedMint: MINT_ADDRESS,
      expectedOwner: OWNER,
      // One base unit short of what the chain holds.
      expectedAmountBaseUnits: "99999999",
      mintAuthorityResolved: true,
      // The caller asserts every box is ticked; the chain disagrees.
      finality: "finalized",
      destinationAccountVerified: true,
      quantityVerified: true,
      lockupVerified: true,
      scheduleMatchesAgreement: true,
      ledgerReconciled: true,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; reasons: string[] };
    expect(body.code).toBe("stamp_delivery_unverified");
    expect(body.reasons.join(" ")).toMatch(/does not match the delivery/);
  });

  it("refuses a transaction that has only reached confirmation", async () => {
    instance = makeApp({ finality: "confirmed" });
    const requestId = await delivered();
    const res = await post(`/admin/delivery/${requestId}/reconcile`, {
      signature: "delivery-signature",
      expectedMint: MINT_ADDRESS,
      expectedOwner: OWNER,
      expectedAmountBaseUnits: "100000000",
      mintAuthorityResolved: true,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { reasons: string[] };
    expect(body.reasons.join(" ")).toMatch(/does not meet the required finalized/);
  });

  it("keeps the attestation path when this host has no RPC, and says so", async () => {
    instance = createStampRoutes({ mode: "manual_review", reviewers: [REVIEWER] });
    const requestId = await delivered();
    const res = await post(`/admin/delivery/${requestId}/reconcile`, {
      finality: "finalized",
      destinationAccountVerified: true,
      quantityVerified: true,
      lockupVerified: true,
      scheduleMatchesAgreement: true,
      ledgerReconciled: true,
      mintAuthorityResolved: true,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { chainVerified: boolean; note: string };
    expect(body.chainVerified).toBe(false);
    expect(body.note).toMatch(/no Solana RPC is configured/);
  });
});