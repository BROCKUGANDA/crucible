/**
 * Signed human attestations — an alternative to a Passport score that needs no vendor.
 *
 * A third-party humanity score is one company's opinion behind an API key. This is the same
 * idea reduced to what the chain already believes: an issuer the deployment names signs a
 * statement about a wallet, and the wallet presents that signature. Verification is local
 * cryptography (`personal_sign` recovery) against an allowlist — no network call, no key of
 * ours, no account to create.
 *
 * What it does NOT claim: that any issuer exists. With `IDENTITY_ATTESTORS` empty the source
 * reports `configured: false` and contributes no signal, exactly as the Passport slot does.
 * A signature from an address nobody named is ignored, not trusted.
 */

import { verifyMessage, type Address } from "viem";

/** The exact bytes an issuer signs. Never build this ad hoc at a call site. */
export function attestationMessage(wallet: string, issuedAt: number, expiry: number): string {
  return [
    "Crucible human attestation",
    `wallet: ${wallet.toLowerCase()}`,
    `issuedAt: ${issuedAt}`,
    `expiry: ${expiry}`,
  ].join("\n");
}

export interface AttestationProof {
  signature: string;
  issuedAt: number;
  expiry: number;
}

export type AttestationOutcome =
  | { ok: true; issuer: Address }
  | { ok: false; reason: string };

/** Parse the three query values; all-or-nothing, because half a proof is not a proof. */
export function parseAttestationProof(query: {
  attestation?: string;
  attestationIssuedAt?: string;
  attestationExpiry?: string;
}): AttestationProof | null {
  if (!query.attestation && !query.attestationIssuedAt && !query.attestationExpiry) return null;
  const issuedAt = Number(query.attestationIssuedAt);
  const expiry = Number(query.attestationExpiry);
  if (!query.attestation || !Number.isFinite(issuedAt) || !Number.isFinite(expiry)) return null;
  return { signature: query.attestation, issuedAt, expiry };
}

/**
 * Recover the signer and check it against the deployed allowlist and the clock.
 *
 * `nowSeconds` is the chain clock, not `Date.now()`: an expiry is a fact about the chain this
 * deployment serves, and a host clock that disagrees must not extend or revoke it.
 */
export async function verifyAttestation(
  wallet: string,
  proof: AttestationProof,
  allowlist: readonly string[],
  nowSeconds: number | null,
): Promise<AttestationOutcome> {
  if (allowlist.length === 0) return { ok: false, reason: "no attestor is configured on this host" };
  if (nowSeconds === null) return { ok: false, reason: "no chain clock; expiry cannot be judged" };
  if (!Number.isFinite(proof.expiry) || proof.expiry <= nowSeconds) {
    return { ok: false, reason: "attestation expired" };
  }
  if (Number.isFinite(proof.issuedAt) && proof.issuedAt > nowSeconds + 300) {
    return { ok: false, reason: "attestation issued in the future" };
  }
  const message = attestationMessage(wallet, proof.issuedAt, proof.expiry);
  for (const issuer of allowlist) {
    try {
      const ok = await verifyMessage({
        address: issuer as Address,
        message,
        signature: proof.signature as `0x${string}`,
      });
      if (ok) return { ok: true, issuer: issuer as Address };
    } catch {
      // A malformed signature throws; an unrelated issuer returns false. Both mean "try the next".
    }
  }
  return { ok: false, reason: "no configured attestor signed this statement" };
}