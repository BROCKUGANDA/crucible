/**
 * @file manifest.ts — the production preflight manifest.
 *
 * `STAMP_MODE=production` is only ever a request. The request is granted when
 * every live value matches a signed, version-controlled, secret-free manifest.
 * The manifest is the contract between the legal approval and the running
 * process: it names the issuer, the entity, the chain, the mints, the wallets,
 * the lock-up mechanism, the allocations and the people who approved it.
 *
 * The comparison is deliberately literal. A field that is absent from the live
 * configuration is a mismatch, not a wildcard: "we could not tell" is a reason
 * to refuse, not a reason to proceed. The whole point of a preflight is that it
 * is boring: it compares strings and refuses when they differ.
 */

export interface PreflightManifest {
  /** The manifest's own version; a manifest without one is not reviewable. */
  version: string;
  /** The issuer's legal entity. */
  issuerLegalEntityId: string;
  issuerJurisdiction: string;
  /** The hash of the current legal agreement version. */
  legalAgreementSha256: string;
  /** A reference to counsel's approval evidence. */
  counselApprovalRef: string;
  /** MetaDAO's project reference. */
  metaDaoProjectRef: string;
  /** The Solana cluster and its expected genesis hash. */
  solanaCluster: string;
  solanaGenesisHash: string;
  /** The accepted stablecoin mint. */
  acceptedStablecoinMint: string;
  /** The approved receipt wallet. */
  approvedWallet: string;
  /** The token mint and the token program. */
  tokenMint: string;
  tokenProgramId: string;
  /** The DAO treasury address. */
  daoTreasuryAddress: string;
  /** The lock-up / vesting mechanism identifiers. */
  vestingMechanism: string;
  vestingAccountRef: string;
  /** The hash of the verified IP assignment manifest. */
  ipAssignmentManifestSha256: string;
  /** The allocation inputs, in basis points. */
  investorReserveBps: string;
  teamAllocationBps: string;
  totalNetworkTokens: string;
  /** The people who approved the manifest. */
  approvals: { name: string; role: string; at: string }[];
}

export interface LiveConfiguration {
  issuerLegalEntityId?: string | null;
  issuerJurisdiction?: string | null;
  legalAgreementSha256?: string | null;
  counselApprovalRef?: string | null;
  metaDaoProjectRef?: string | null;
  solanaCluster?: string | null;
  solanaGenesisHash?: string | null;
  acceptedStablecoinMint?: string | null;
  approvedWallet?: string | null;
  tokenMint?: string | null;
  tokenProgramId?: string | null;
  daoTreasuryAddress?: string | null;
  vestingMechanism?: string | null;
  vestingAccountRef?: string | null;
  ipAssignmentManifestSha256?: string | null;
  investorReserveBps?: string | null;
  teamAllocationBps?: string | null;
  totalNetworkTokens?: string | null;
  approvals?: { name: string; role: string; at: string }[] | null;
}

export interface ManifestComparison {
  ok: boolean;
  mismatches: { field: string; expected: string; actual: string }[];
  /** Fields the live configuration did not supply at all. */
  missing: string[];
}

/** The manifest fields compared against live configuration, in a fixed order. */
export const COMPARED_FIELDS: (keyof LiveConfiguration)[] = [
  "issuerLegalEntityId",
  "issuerJurisdiction",
  "legalAgreementSha256",
  "counselApprovalRef",
  "metaDaoProjectRef",
  "solanaCluster",
  "solanaGenesisHash",
  "acceptedStablecoinMint",
  "approvedWallet",
  "tokenMint",
  "tokenProgramId",
  "daoTreasuryAddress",
  "vestingMechanism",
  "vestingAccountRef",
  "ipAssignmentManifestSha256",
  "investorReserveBps",
  "teamAllocationBps",
  "totalNetworkTokens",
];

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return value.toString();
  return JSON.stringify(value);
}

/**
 * Compare the manifest against the live configuration.
 *
 * A missing live value is reported separately from a wrong one, because they
 * are different failures: one means the process was not configured, the other
 * means it was configured to something the approval does not cover.
 */
export function compareManifest(
  manifest: PreflightManifest,
  live: LiveConfiguration,
): ManifestComparison {
  const mismatches: ManifestComparison["mismatches"] = [];
  const missing: string[] = [];

  for (const field of COMPARED_FIELDS) {
    const expected = stringify((manifest as unknown as Record<string, unknown>)[field]);
    const actual = stringify(live[field]);
    if (actual === "") {
      missing.push(field);
      continue;
    }
    if (expected !== actual) {
      mismatches.push({ field, expected, actual });
    }
  }

  // Two named approvers, and they must be two people.
  const approvals = live.approvals ?? [];
  const expectedApprovals = manifest.approvals ?? [];
  if (approvals.length !== expectedApprovals.length) {
    mismatches.push({
      field: "approvals",
      expected: `${expectedApprovals.length} approvals`,
      actual: `${approvals.length} approvals`,
    });
  } else {
    for (let i = 0; i < approvals.length; i++) {
      const expectedApproval = expectedApprovals[i]!;
      const actualApproval = approvals[i]!;
      if (
        expectedApproval.name !== actualApproval.name ||
        expectedApproval.role !== actualApproval.role
      ) {
        mismatches.push({
          field: `approvals[${i}]`,
          expected: `${expectedApproval.name} (${expectedApproval.role})`,
          actual: `${actualApproval.name} (${actualApproval.role})`,
        });
      }
    }
    const names = new Set(approvals.map((a) => a.name));
    if (names.size !== approvals.length) {
      mismatches.push({
        field: "approvals",
        expected: "distinct approvers",
        actual: "the same approver signed more than once",
      });
    }
  }

  return { ok: mismatches.length === 0 && missing.length === 0, mismatches, missing };
}

/**
 * The mode gate.
 *
 * `disabled` off. `sandbox` and `manual_review` on, with their own limits. Only
 * `production` consults the manifest, and only a clean comparison turns it on.
 */
export function productionMayRun(comparison: ManifestComparison): {
  allowed: boolean;
  reason: string | null;
} {
  if (comparison.missing.length > 0) {
    return {
      allowed: false,
      reason: `live configuration is missing ${comparison.missing.join(", ")}`,
    };
  }
  if (comparison.mismatches.length > 0) {
    return {
      allowed: false,
      reason: comparison.mismatches
        .map((m) => `${m.field}: expected ${m.expected}, live ${m.actual}`)
        .join("; "),
    };
  }
  return { allowed: true, reason: null };
}