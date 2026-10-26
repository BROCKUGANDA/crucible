import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { attestationMessage, parseAttestationProof, verifyAttestation } from "../src/attestation.js";
import { createApp } from "../src/app.js";
import type { ReadModel } from "@crucible/indexer";

/**
 * A humanity signal that needs no vendor and no credential of ours: an issuer the deployment
 * names signs a statement about a wallet, and the host recovers the signer locally. The tests
 * below are the whole contract — a signature from anyone else, an expired one, or one with no
 * issuer configured must contribute nothing.
 */
const issuer = privateKeyToAccount("0x" + "11".repeat(32));
const stranger = privateKeyToAccount("0x" + "22".repeat(32));
const WALLET = "0x" + "ab".repeat(20);
const NOW = 1_800_000_000;

async function proof(account = issuer, over: { issuedAt?: number; expiry?: number; wallet?: string } = {}) {
  const issuedAt = over.issuedAt ?? NOW - 60;
  const expiry = over.expiry ?? NOW + 3600;
  const signature = await account.signMessage({
    message: attestationMessage(over.wallet ?? WALLET, issuedAt, expiry),
  });
  return { signature, issuedAt, expiry };
}

const emptyModel = () =>
  ({ trials: new Map(), agents: new Map(), runs: new Map(), disputes: new Map(), appliedLogs: new Set(), version: 0 }) as unknown as ReadModel;

describe("signed human attestations", () => {
  it("accepts a statement from a configured issuer", async () => {
    const out = await verifyAttestation(WALLET, await proof(), [issuer.address], NOW);
    expect(out).toEqual({ ok: true, issuer: issuer.address });
  });

  it("ignores a signature from an address the deployment did not name", async () => {
    const out = await verifyAttestation(WALLET, await proof(stranger), [issuer.address], NOW);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("no configured attestor");
  });

  it("refuses when no issuer is configured at all", async () => {
    const out = await verifyAttestation(WALLET, await proof(), [], NOW);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("no attestor is configured");
  });

  it("refuses an expired attestation on the chain clock", async () => {
    const out = await verifyAttestation(WALLET, await proof(issuer, { expiry: NOW - 1 }), [issuer.address], NOW);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("attestation expired");
  });

  it("refuses an attestation issued in the future", async () => {
    const out = await verifyAttestation(
      WALLET,
      await proof(issuer, { issuedAt: NOW + 3600, expiry: NOW + 7200 }),
      [issuer.address],
      NOW,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("future");
  });

  it("refuses to judge expiry without a chain clock", async () => {
    const out = await verifyAttestation(WALLET, await proof(), [issuer.address], null);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("no chain clock");
  });

  it("rejects a signature made for a different wallet", async () => {
    const other = "0x" + "cd".repeat(20);
    const out = await verifyAttestation(WALLET, await proof(issuer, { wallet: other }), [issuer.address], NOW);
    expect(out.ok).toBe(false);
  });

  it("rejects a malformed signature without throwing", async () => {
    const out = await verifyAttestation(WALLET, { signature: "0xdeadbeef", issuedAt: NOW - 1, expiry: NOW + 60 }, [issuer.address], NOW);
    expect(out.ok).toBe(false);
  });

  it("parses the three query values all-or-nothing", () => {
    expect(parseAttestationProof({})).toBeNull();
    expect(parseAttestationProof({ attestation: "0xabc" })).toBeNull();
    expect(parseAttestationProof({ attestation: "0xabc", attestationIssuedAt: "1", attestationExpiry: "2" })).toEqual({
      signature: "0xabc",
      issuedAt: 1,
      expiry: 2,
    });
  });
});

describe("the evidence route reports the attestation source honestly", () => {
  it("says unconfigured when no issuer is named", async () => {
    const app = createApp({ getModel: emptyModel }, { rateLimit: false });
    const body = await (await app.request(`/identity/evidence/${WALLET}`)).json();
    expect(body.sources.attestation.configured).toBe(false);
    expect(body.sources.passport.configured).toBe(false);
    expect(body.evidence.map((e: { name: string }) => e.name)).not.toContain("attestedHuman");
  });

  it("adds the signal only when a configured issuer signed it", async () => {
    const app = createApp(
      { getModel: emptyModel, humanAttestors: [issuer.address], indexStatus: () => ({ headTimestamp: NOW }) as never },
      { rateLimit: false },
    );
    const p = await proof();
    const query = `attestation=${p.signature}&attestationIssuedAt=${p.issuedAt}&attestationExpiry=${p.expiry}`;

    const signed = await (
      await app.request(`/identity/evidence/${WALLET}?${query}`)
    ).json();
    expect(signed.sources.attestation.present).toBe(true);
    expect(signed.sources.attestation.issuer).toBe(issuer.address);
    expect(signed.evidence.map((e: { name: string }) => e.name)).toContain("attestedHuman");

    const unsigned = await (await app.request(`/identity/evidence/${WALLET}`)).json();
    expect(unsigned.sources.attestation.configured).toBe(true);
    expect(unsigned.sources.attestation.present).toBe(false);
    expect(unsigned.evidence.map((e: { name: string }) => e.name)).not.toContain("attestedHuman");
  });

  it("does not count a stranger's signature", async () => {
    const app = createApp(
      { getModel: emptyModel, humanAttestors: [issuer.address], indexStatus: () => ({ headTimestamp: NOW }) as never },
      { rateLimit: false },
    );
    const p = await proof(stranger);
    const query = `attestation=${p.signature}&attestationIssuedAt=${p.issuedAt}&attestationExpiry=${p.expiry}`;
    const body = await (await app.request(`/identity/evidence/${WALLET}?${query}`)).json();
    expect(body.sources.attestation.present).toBe(false);
    expect(body.evidence.map((e: { name: string }) => e.name)).not.toContain("attestedHuman");
  });
});
