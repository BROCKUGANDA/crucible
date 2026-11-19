import { describe, expect, it } from "vitest";
import {
  availableDeliveryPortion,
  combineGates,
  deliveryGate,
  deliveryQuantityGate,
  findPlaceholders,
  insiderParity,
  ipPerimeterGaps,
  paymentGate,
  tokenomicsGate,
} from "../src/policies.js";
import { compareManifest, productionMayRun } from "../src/manifest.js";
import { applyAssignment, verifyNoDoubleCount } from "../src/assignment.js";

describe("placeholder detection", () => {
  it("finds the blanks the STAMP template ships with", () => {
    const document = "This Agreement is made by [Company Name] with [Jurisdiction].";
    const reasons = findPlaceholders(document);
    expect(reasons.length).toBeGreaterThanOrEqual(2);
    expect(reasons.map((r) => r.code)).toContain("placeholder_bracket");
  });

  it("finds template and fill-in markers", () => {
    expect(findPlaceholders("{{holder}}").length).toBeGreaterThan(0);
    expect(findPlaceholders("________").length).toBeGreaterThan(0);
    expect(findPlaceholders("INSERT GOVERNING LAW").length).toBeGreaterThan(0);
  });

  it("passes a document with no blanks", () => {
    expect(findPlaceholders("Signed by Crucible Protocol Issuer, a Delaware corporation.")).toEqual([]);
  });
});

describe("insider lock-up parity", () => {
  it("accepts an insider schedule at least as onerous", () => {
    const result = insiderParity(
      { months: 24, cliffMonths: 0, restrictions: ["no transfer", "no staking"] },
      { months: 24, cliffMonths: 0, restrictions: ["no transfer", "no staking"] },
    );
    expect(result.ok).toBe(true);
  });

  it("refuses an insider that unlocks earlier", () => {
    const result = insiderParity({ months: 24 }, { months: 12 });
    expect(result.ok).toBe(false);
    expect(result.reasons.map((r) => r.code)).toContain("insider_unlock_earlier");
  });

  it("refuses an insider with a shorter cliff", () => {
    const result = insiderParity({ months: 24, cliffMonths: 6 }, { months: 24, cliffMonths: 0 });
    expect(result.ok).toBe(false);
    expect(result.reasons.map((r) => r.code)).toContain("insider_cliff_shorter");
  });

  it("refuses an insider with fewer restrictions", () => {
    const result = insiderParity(
      { months: 24, restrictions: ["a", "b"] },
      { months: 24, restrictions: ["a"] },
    );
    expect(result.ok).toBe(false);
  });
});

describe("IP perimeter", () => {
  const issuer = "Crucible Protocol Issuer";

  it("passes a fully assigned perimeter with evidence", () => {
    const result = ipPerimeterGaps(
      [{ id: "1", kind: "repository", description: "crucible-contracts", status: "ASSIGNED", ownerEntity: issuer, evidenceRef: "deed-1" }],
      issuer,
    );
    expect(result.ok).toBe(true);
  });

  it("refuses unassigned, disputed and out-of-perimeter assets", () => {
    const result = ipPerimeterGaps(
      [
        { id: "1", kind: "repository", description: "a", status: "UNASSIGNED" },
        { id: "2", kind: "trademark", description: "b", status: "DISPUTED" },
        { id: "3", kind: "domain", description: "c", status: "ASSIGNED", ownerEntity: "AI Azimara" },
        { id: "4", kind: "dataset", description: "d", status: "ASSIGNED", ownerEntity: issuer },
      ],
      issuer,
    );
    expect(result.ok).toBe(false);
    const codes = result.reasons.map((r) => r.code);
    expect(codes).toContain("ip_unassigned");
    expect(codes).toContain("ip_disputed");
    expect(codes).toContain("ip_outside_perimeter");
    expect(codes).toContain("ip_no_evidence");
  });

  it("ignores assets marked immaterial", () => {
    const result = ipPerimeterGaps(
      [{ id: "1", kind: "website", description: "blog", status: "UNASSIGNED", material: false }],
      issuer,
    );
    expect(result.ok).toBe(true);
  });
});

describe("tokenomics gate", () => {
  const base = {
    investorReserveBps: 2000n,
    teamAllocationBps: 2000n,
    totalNetworkTokens: 100_000_000n,
    investorPortionTotal: 20_000_000n,
    supplySnapshotMatchesChain: true,
    metaDaoApproved: true,
  };

  it("passes a reconciled tokenomics", () => {
    expect(tokenomicsGate(base).ok).toBe(true);
  });

  it("refuses an investor reserve over the cap", () => {
    const result = tokenomicsGate({ ...base, investorReserveBps: 2001n });
    expect(result.ok).toBe(false);
    expect(result.reasons.map((r) => r.code)).toContain("reserve_over_cap");
  });

  it("refuses a team allocation outside the band", () => {
    expect(tokenomicsGate({ ...base, teamAllocationBps: 999n }).ok).toBe(false);
    expect(tokenomicsGate({ ...base, teamAllocationBps: 4001n }).ok).toBe(false);
  });

  it("refuses a supply snapshot that disagrees with the chain", () => {
    const result = tokenomicsGate({ ...base, supplySnapshotMatchesChain: false });
    expect(result.reasons.map((r) => r.code)).toContain("supply_snapshot_mismatch");
  });

  it("refuses without MetaDAO approval", () => {
    const result = tokenomicsGate({ ...base, metaDaoApproved: false });
    expect(result.reasons.map((r) => r.code)).toContain("meta_dao_not_approved");
  });
});

describe("payment gate", () => {
  const base = {
    approvedMint: "USDC_MINT",
    observedMint: "USDC_MINT" as string | null,
    approvedCluster: "devnet",
    observedCluster: "devnet" as string | null,
    approvedWallet: "WALLET",
    observedRecipient: "WALLET" as string | null,
    canonical: true,
    amountMatches: true,
    hasSignedInstrument: true,
  };

  it("passes a canonical payment of the right asset to the right wallet", () => {
    expect(paymentGate(base).ok).toBe(true);
  });

  it("refuses the wrong mint", () => {
    const result = paymentGate({ ...base, observedMint: "OTHER" });
    expect(result.reasons.map((r) => r.code)).toContain("wrong_mint");
  });

  it("refuses the wrong cluster", () => {
    const result = paymentGate({ ...base, observedCluster: "mainnet" });
    expect(result.reasons.map((r) => r.code)).toContain("wrong_cluster");
  });

  it("refuses the wrong wallet", () => {
    const result = paymentGate({ ...base, observedRecipient: "SOMEONE_ELSE" });
    expect(result.reasons.map((r) => r.code)).toContain("wrong_wallet");
  });

  it("refuses a non-canonical transaction", () => {
    const result = paymentGate({ ...base, canonical: false });
    expect(result.reasons.map((r) => r.code)).toContain("payment_not_canonical");
  });

  it("refuses a payment with no signed instrument behind it", () => {
    const result = paymentGate({ ...base, hasSignedInstrument: false });
    expect(result.reasons.map((r) => r.code)).toContain("no_signed_instrument");
  });
});

describe("delivery gate", () => {
  const base = {
    finality: "finalized" as const,
    destinationAccountVerified: true,
    quantityVerified: true,
    lockupVerified: true,
    scheduleMatchesAgreement: true,
    ledgerReconciled: true,
    mintAuthorityResolved: true,
  };

  it("passes a fully verified delivery", () => {
    expect(deliveryGate(base).ok).toBe(true);
  });

  it("refuses a submitted-but-unfinalized transaction", () => {
    const result = deliveryGate({ ...base, finality: "submitted" });
    expect(result.reasons.map((r) => r.code)).toContain("not_final");
  });

  it("refuses a reorged transaction", () => {
    const result = deliveryGate({ ...base, finality: "reorged" });
    expect(result.reasons.map((r) => r.code)).toContain("transaction_reorged");
  });

  it("refuses an unreconciled ledger", () => {
    const result = deliveryGate({ ...base, ledgerReconciled: false });
    expect(result.reasons.map((r) => r.code)).toContain("ledger_not_reconciled");
  });
});

describe("combined gates", () => {
  it("collects every reason", () => {
    const result = combineGates(
      { ok: true, reasons: [] },
      { ok: false, reasons: [{ code: "x", detail: "y" }] },
      { ok: false, reasons: [{ code: "z", detail: "w" }] },
    );
    expect(result.ok).toBe(false);
    expect(result.reasons).toHaveLength(2);
  });
});

describe("preflight manifest", () => {
  const manifest = {
    version: "1",
    issuerLegalEntityId: "entity-1",
    issuerJurisdiction: "US-DE",
    legalAgreementSha256: "abc",
    counselApprovalRef: "counsel-1",
    metaDaoProjectRef: "metadao-1",
    solanaCluster: "devnet",
    solanaGenesisHash: "genesis",
    acceptedStablecoinMint: "usdc",
    approvedWallet: "wallet",
    tokenMint: "token",
    tokenProgramId: "program",
    daoTreasuryAddress: "treasury",
    vestingMechanism: "vesting",
    vestingAccountRef: "account",
    ipAssignmentManifestSha256: "ip-hash",
    investorReserveBps: "2000",
    teamAllocationBps: "2000",
    totalNetworkTokens: "100000000",
    approvals: [
      { name: "A", role: "counsel", at: "2026-01-01" },
      { name: "B", role: "operator", at: "2026-01-02" },
    ],
  };

  it("passes when every live value matches", () => {
    const comparison = compareManifest(manifest, { ...manifest });
    expect(comparison.ok).toBe(true);
    expect(productionMayRun(comparison).allowed).toBe(true);
  });

  it("treats an absent live value as a failure, not a wildcard", () => {
    const comparison = compareManifest(manifest, { ...manifest, tokenMint: undefined });
    expect(comparison.ok).toBe(false);
    expect(comparison.missing).toContain("tokenMint");
    expect(productionMayRun(comparison).allowed).toBe(false);
  });

  it("reports a value that differs from the approval", () => {
    const comparison = compareManifest(manifest, { ...manifest, approvedWallet: "other" });
    expect(comparison.mismatches.map((m) => m.field)).toContain("approvedWallet");
    expect(productionMayRun(comparison).allowed).toBe(false);
  });

  it("refuses when the same person signed twice", () => {
    const comparison = compareManifest(manifest, {
      ...manifest,
      approvals: [
        { name: "A", role: "counsel", at: "2026-01-01" },
        { name: "A", role: "operator", at: "2026-01-02" },
      ],
    });
    expect(comparison.ok).toBe(false);
  });
});

describe("assignment", () => {
  const rows = [
    { instrumentId: "i1", holderId: "a", portionBaseUnits: 100n, active: true },
    { instrumentId: "i2", holderId: "b", portionBaseUnits: 200n, active: true },
  ];

  it("moves the portion without changing the aggregate", () => {
    const result = applyAssignment(rows, {
      instrumentId: "i1",
      fromHolderId: "a",
      toHolderId: "c",
      effectiveAt: 1,
      reviewRef: "review-1",
    });
    expect(result.ok).toBe(true);
    expect(result.aggregateBaseUnits).toBe("300");
    const live = result.rows.filter((r) => r.active);
    expect(live).toHaveLength(2);
    expect(live.find((r) => r.instrumentId === "i1")!.holderId).toBe("c");
  });

  it("refuses an assignment from the wrong holder", () => {
    const result = applyAssignment(rows, {
      instrumentId: "i1",
      fromHolderId: "zzz",
      toHolderId: "c",
      effectiveAt: 1,
      reviewRef: "review-1",
    });
    expect(result.ok).toBe(false);
  });

  it("refuses a second live allocation for the same instrument", () => {
    const doubled = [
      ...rows,
      { instrumentId: "i1", holderId: "c", portionBaseUnits: 100n, active: true },
    ];
    const result = applyAssignment(doubled, {
      instrumentId: "i1",
      fromHolderId: "a",
      toHolderId: "c",
      effectiveAt: 1,
      reviewRef: "review-1",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/already has a live allocation/);
  });

  it("detects a double count in a stored set of rows", () => {
    const bad = [
      { instrumentId: "i1", holderId: "a", portionBaseUnits: 100n, active: true },
      { instrumentId: "i1", holderId: "c", portionBaseUnits: 100n, active: true },
    ];
    expect(verifyNoDoubleCount(bad, 200n).ok).toBe(false);
    expect(verifyNoDoubleCount(rows, 300n).ok).toBe(true);
    expect(verifyNoDoubleCount(rows, 301n).ok).toBe(false);
  });
});

describe("delivery quantity", () => {
  it("allows a delivery up to the portion and refuses one unit more", () => {
    const portion = 1_000_000n;
    expect(deliveryQuantityGate({ holderPortionTokens: portion, requestedTokens: portion }).ok).toBe(true);
    const over = deliveryQuantityGate({ holderPortionTokens: portion, requestedTokens: portion + 1n });
    expect(over.ok).toBe(false);
    expect(over.reasons[0]?.code).toBe("portion_exceeded");
  });

  it("subtracts prior deliveries", () => {
    const input = { holderPortionTokens: 1_000n, priorDeliveredTokens: 400n };
    expect(deliveryQuantityGate({ ...input, requestedTokens: 600n }).ok).toBe(true);
    expect(deliveryQuantityGate({ ...input, requestedTokens: 601n }).ok).toBe(false);
    expect(availableDeliveryPortion(input)).toBe(600n);
  });

  it("refuses a negative amount rather than reading it as small", () => {
    const negative = deliveryQuantityGate({ holderPortionTokens: 10n, requestedTokens: -1n });
    expect(negative.ok).toBe(false);
    expect(negative.reasons[0]?.code).toBe("negative_amount");
  });

  it("refuses when prior deliveries already exceed the portion", () => {
    const result = deliveryQuantityGate({
      holderPortionTokens: 100n,
      priorDeliveredTokens: 101n,
      requestedTokens: 0n,
    });
    expect(result.ok).toBe(false);
    expect(result.reasons[0]?.code).toBe("portion_already_exceeded");
    // And the helper never reports a negative remainder.
    expect(availableDeliveryPortion({ holderPortionTokens: 100n, priorDeliveredTokens: 101n })).toBe(0n);
  });

  it("treats a zero portion as zero, not as unlimited", () => {
    expect(deliveryQuantityGate({ holderPortionTokens: 0n, requestedTokens: 1n }).ok).toBe(false);
    expect(deliveryQuantityGate({ holderPortionTokens: 0n, requestedTokens: 0n }).ok).toBe(true);
  });
});