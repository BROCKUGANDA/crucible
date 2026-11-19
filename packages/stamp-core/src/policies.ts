/**
 * @file policies.ts — the fail-closed gates.
 *
 * Every gate in this file answers one question: may this irreversible thing
 * happen right now? The answer is a list of reasons, and the list is empty only
 * when the answer is yes.
 *
 * Two properties matter more than the individual gates:
 *
 *   1. **Fail closed.** An unknown input is a reason, not a pass. A gate that
 *      treats "we could not tell" as "fine" is worse than no gate, because it
 *      reads like one.
 *   2. **Named reasons.** Every reason says what is wrong and which input
 *      caused it, so an operator can fix it. A gate that returns a bare `false`
 *      has thrown the diagnosis away.
 */

import { INVESTOR_RESERVE_CAP_BPS, TEAM_ALLOCATION_MAX_BPS, TEAM_ALLOCATION_MIN_BPS } from "./allocations.js";

export interface GateReason {
  code: string;
  detail: string;
}

export interface GateResult {
  ok: boolean;
  reasons: GateReason[];
}

/* ------------------------------------------------------------------ */
/* Legal document hygiene                                               */
/* ------------------------------------------------------------------ */

/**
 * Placeholders left in a legal document.
 *
 * The template ships with blanks for company name, founders, entity type,
 * jurisdiction and governing law. A document that still carries one has not
 * been agreed, and no money may move under it.
 */
export function findPlaceholders(documentText: string): GateReason[] {
  const reasons: GateReason[] = [];
  const patterns: { code: string; re: RegExp; label: string }[] = [
    { code: "placeholder_bracket", re: /\[[^\]\n]{1,80}\]/g, label: "bracketed blank" },
    { code: "placeholder_angle", re: /<[A-Z][A-Z _/.-]{2,60}>/g, label: "angle-bracket blank" },
    { code: "placeholder_curly", re: /\{\{[^}\n]{1,80}\}\}/g, label: "template blank" },
    { code: "placeholder_dunder", re: /_{4,}/g, label: "fill-in line" },
    { code: "placeholder_insert", re: /\bINSERT\s+[A-Z][A-Z ]{2,40}\b/g, label: "insert marker" },
  ];
  for (const p of patterns) {
    for (const match of documentText.matchAll(p.re)) {
      reasons.push({
        code: p.code,
        detail: `${p.label} left in the document: ${match[0].slice(0, 80)}`,
      });
    }
  }
  return reasons;
}

/* ------------------------------------------------------------------ */
/* Insider lock-up parity                                                */
/* ------------------------------------------------------------------ */

export interface LockUpSchedule {
  /** Months over which the tokens unlock. */
  months: number;
  /** An additional cliff, in months, before the first release. */
  cliffMonths?: number;
  /** A free-text description of any other restriction. */
  restrictions?: string[];
}

/**
 * Insiders must not be treated less onerously than investors.
 *
 * The template says the investor lock-up does not apply to a holder unless
 * insider tokens have restrictions at least as onerous. So the comparison runs
 * both ways: an insider schedule that is shorter, has a shorter cliff, or
 * carries fewer restrictions than the holder schedule is a violation.
 */
export function insiderParity(
  investor: LockUpSchedule,
  insider: LockUpSchedule,
): GateResult {
  const reasons: GateReason[] = [];
  const investorMonths = investor.months;
  const insiderMonths = insider.months;
  if (insiderMonths < investorMonths) {
    reasons.push({
      code: "insider_unlock_earlier",
      detail: `insider unlocks over ${insiderMonths} months against the investor's ${investorMonths}`,
    });
  }
  const investorCliff = investor.cliffMonths ?? 0;
  const insiderCliff = insider.cliffMonths ?? 0;
  if (insiderCliff < investorCliff) {
    reasons.push({
      code: "insider_cliff_shorter",
      detail: `insider cliff ${insiderCliff} months against the investor's ${investorCliff}`,
    });
  }
  const investorRestrictions = investor.restrictions ?? [];
  const insiderRestrictions = insider.restrictions ?? [];
  if (insiderRestrictions.length < investorRestrictions.length) {
    reasons.push({
      code: "insider_fewer_restrictions",
      detail: `insider carries ${insiderRestrictions.length} restrictions against the investor's ${investorRestrictions.length}`,
    });
  }
  return { ok: reasons.length === 0, reasons };
}

/* ------------------------------------------------------------------ */
/* IP perimeter                                                         */
/* ------------------------------------------------------------------ */

export type IpAssetStatus = "ASSIGNED" | "UNASSIGNED" | "PARTIAL" | "DISPUTED";

export interface IpAsset {
  id: string;
  kind: "repository" | "package" | "trademark" | "domain" | "dataset" | "website" | "invention" | "licence";
  description: string;
  status: IpAssetStatus;
  /** The entity that owns the asset, when assigned. */
  ownerEntity?: string | null;
  /** Evidence reference (assignment deed, employment clause, licence). */
  evidenceRef?: string | null;
  /** Whether the asset is material to the protocol. */
  material?: boolean;
}

/**
 * The IP perimeter check.
 *
 * A material asset that is unassigned, partially assigned, disputed, or
 * assigned to an entity outside the issuer's perimeter blocks the launch: the
 * MetaDAO structure expects the issuer to hold the IP.
 */
export function ipPerimeterGaps(assets: readonly IpAsset[], issuerEntity: string): GateResult {
  const reasons: GateReason[] = [];
  for (const asset of assets) {
    if (asset.material === false) continue;
    if (asset.status === "UNASSIGNED") {
      reasons.push({ code: "ip_unassigned", detail: `${asset.kind} "${asset.description}" is unassigned` });
      continue;
    }
    if (asset.status === "PARTIAL") {
      reasons.push({ code: "ip_partial", detail: `${asset.kind} "${asset.description}" is only partially assigned` });
      continue;
    }
    if (asset.status === "DISPUTED") {
      reasons.push({ code: "ip_disputed", detail: `${asset.kind} "${asset.description}" is disputed` });
      continue;
    }
    if (!asset.ownerEntity) {
      reasons.push({ code: "ip_no_owner", detail: `${asset.kind} "${asset.description}" has no recorded owner` });
      continue;
    }
    if (asset.ownerEntity !== issuerEntity) {
      reasons.push({
        code: "ip_outside_perimeter",
        detail: `${asset.kind} "${asset.description}" is held by ${asset.ownerEntity}, not ${issuerEntity}`,
      });
      continue;
    }
    if (!asset.evidenceRef) {
      reasons.push({
        code: "ip_no_evidence",
        detail: `${asset.kind} "${asset.description}" has no assignment evidence reference`,
      });
    }
  }
  return { ok: reasons.length === 0, reasons };
}

/* ------------------------------------------------------------------ */
/* Allocation and tokenomics gates                                      */
/* ------------------------------------------------------------------ */

export interface AllocationGateInput {
  /** Sum of the effective investor allocations, in basis points. */
  investorReserveBps: bigint;
  /** The founder / service-provider allocation, in basis points. */
  teamAllocationBps: bigint;
  /** The total network-token supply, in base units. */
  totalNetworkTokens: bigint;
  /** The sum of the investor portions, in base units. */
  investorPortionTotal: bigint;
  /** Whether the legal supply snapshot and the chain state agree. */
  supplySnapshotMatchesChain: boolean;
  /** Whether MetaDAO has approved the tokenomics. */
  metaDaoApproved: boolean;
}

/**
 * The tokenomics gate: the investor reserve under the cap, the team allocation
 * inside its band, and the supply snapshot reconciled.
 */
export function tokenomicsGate(input: AllocationGateInput): GateResult {
  const reasons: GateReason[] = [];
  if (input.investorReserveBps > INVESTOR_RESERVE_CAP_BPS) {
    reasons.push({
      code: "reserve_over_cap",
      detail: `investor reserve ${input.investorReserveBps} bps exceeds the ${INVESTOR_RESERVE_CAP_BPS} bps cap`,
    });
  }
  if (input.teamAllocationBps < TEAM_ALLOCATION_MIN_BPS || input.teamAllocationBps > TEAM_ALLOCATION_MAX_BPS) {
    reasons.push({
      code: "team_allocation_out_of_band",
      detail: `team allocation ${input.teamAllocationBps} bps is outside ${TEAM_ALLOCATION_MIN_BPS}-${TEAM_ALLOCATION_MAX_BPS} bps`,
    });
  }
  const capShare = (INVESTOR_RESERVE_CAP_BPS * input.totalNetworkTokens) / 10_000n;
  if (input.investorPortionTotal > capShare) {
    reasons.push({
      code: "portion_over_cap_share",
      detail: `investor portions ${input.investorPortionTotal} exceed the cap's share ${capShare}`,
    });
  }
  if (!input.supplySnapshotMatchesChain) {
    reasons.push({
      code: "supply_snapshot_mismatch",
      detail: "the legal supply snapshot and the chain state disagree",
    });
  }
  if (!input.metaDaoApproved) {
    reasons.push({ code: "meta_dao_not_approved", detail: "MetaDAO has not approved the tokenomics" });
  }
  return { ok: reasons.length === 0, reasons };
}

/* ------------------------------------------------------------------ */
/* Payment and delivery gates                                           */
/* ------------------------------------------------------------------ */

export interface PaymentGateInput {
  /** The mint named in the signed agreement. */
  approvedMint: string;
  /** The mint the payment actually used. */
  observedMint: string | null;
  /** The cluster named in the signed agreement. */
  approvedCluster: string;
  /** The cluster the payment was observed on. */
  observedCluster: string | null;
  /** The approved receipt wallet. */
  approvedWallet: string;
  /** The wallet the payment actually went to. */
  observedRecipient: string | null;
  /** Whether the chain says the transaction is canonical and final. */
  canonical: boolean;
  /** Whether the amount matches the agreed purchase price. */
  amountMatches: boolean;
  /** Whether a signed instrument exists for this payment. */
  hasSignedInstrument: boolean;
}

/**
 * A payment is accepted only when every single condition holds. A wrong mint
 * is not "close enough", and a screenshot is not a payment.
 */
export function paymentGate(input: PaymentGateInput): GateResult {
  const reasons: GateReason[] = [];
  if (!input.hasSignedInstrument) {
    reasons.push({ code: "no_signed_instrument", detail: "no signed instrument covers this payment" });
  }
  if (input.observedMint === null) {
    reasons.push({ code: "mint_unobserved", detail: "the payment's asset was not observed" });
  } else if (input.observedMint !== input.approvedMint) {
    reasons.push({
      code: "wrong_mint",
      detail: `payment used mint ${input.observedMint}, the agreement names ${input.approvedMint}`,
    });
  }
  if (input.observedCluster === null) {
    reasons.push({ code: "cluster_unobserved", detail: "the payment's cluster was not observed" });
  } else if (input.observedCluster !== input.approvedCluster) {
    reasons.push({
      code: "wrong_cluster",
      detail: `payment landed on ${input.observedCluster}, the agreement names ${input.approvedCluster}`,
    });
  }
  if (input.observedRecipient === null) {
    reasons.push({ code: "recipient_unobserved", detail: "the payment's recipient was not observed" });
  } else if (input.observedRecipient !== input.approvedWallet) {
    reasons.push({
      code: "wrong_wallet",
      detail: `payment went to ${input.observedRecipient}, the approved wallet is ${input.approvedWallet}`,
    });
  }
  if (!input.canonical) {
    reasons.push({ code: "payment_not_canonical", detail: "the transaction is not canonical and final" });
  }
  if (!input.amountMatches) {
    reasons.push({ code: "amount_mismatch", detail: "the payment amount does not match the agreed price" });
  }
  return { ok: reasons.length === 0, reasons };
}

/* ------------------------------------------------------------------ */
/* Delivery gate                                                        */
/* ------------------------------------------------------------------ */

export interface DeliveryGateInput {
  /** The chain transaction's finality stage. */
  finality: "submitted" | "confirmed" | "finalized" | "reorged";
  /** Whether the destination token account was verified on chain. */
  destinationAccountVerified: boolean;
  /** Whether the exact quantity was verified in integer base units. */
  quantityVerified: boolean;
  /** Whether the lock-up account and beneficiary were verified. */
  lockupVerified: boolean;
  /** Whether the schedule's start date matches the signed agreement. */
  scheduleMatchesAgreement: boolean;
  /** Whether the ledger reconciliation passed. */
  ledgerReconciled: boolean;
  /** Whether no uncontrolled mint authority remains. */
  mintAuthorityResolved: boolean;
}

/**
 * The delivery gate.
 *
 * A submitted transaction is not a delivery. The gate requires the chain's own
 * finality plus an independent ledger reconciliation, so a "delivered" record
 * cannot exist on the strength of a broadcast.
 */
export function deliveryGate(input: DeliveryGateInput): GateResult {
  const reasons: GateReason[] = [];
  if (input.finality === "reorged") {
    reasons.push({ code: "transaction_reorged", detail: "the delivery transaction was reorged" });
  } else if (input.finality !== "finalized") {
    reasons.push({
      code: "not_final",
      detail: `the delivery transaction is ${input.finality}, not finalized`,
    });
  }
  if (!input.destinationAccountVerified) {
    reasons.push({ code: "destination_unverified", detail: "the destination token account was not verified" });
  }
  if (!input.quantityVerified) {
    reasons.push({ code: "quantity_unverified", detail: "the delivered quantity was not verified in base units" });
  }
  if (!input.lockupVerified) {
    reasons.push({ code: "lockup_unverified", detail: "the lock-up account and beneficiary were not verified" });
  }
  if (!input.scheduleMatchesAgreement) {
    reasons.push({ code: "schedule_mismatch", detail: "the vesting schedule does not match the signed agreement" });
  }
  if (!input.ledgerReconciled) {
    reasons.push({ code: "ledger_not_reconciled", detail: "the ledger reconciliation did not pass" });
  }
  if (!input.mintAuthorityResolved) {
    reasons.push({ code: "mint_authority_unresolved", detail: "an uncontrolled mint authority remains" });
  }
  return { ok: reasons.length === 0, reasons };
}

/** Combine gate results into one. */
export function combineGates(...results: GateResult[]): GateResult {
  const reasons = results.flatMap((r) => r.reasons);
  return { ok: reasons.length === 0, reasons };
}

/* ------------------------------------------------------------------ */
/* Delivery quantity                                                    */
/* ------------------------------------------------------------------ */

export interface DeliveryQuantityInput {
  /** The holder's portion from the frozen Schedule 2 snapshot, in base units. */
  holderPortionTokens: bigint;
  /** Everything already delivered under this instrument, in base units. */
  priorDeliveredTokens?: bigint;
  /** What this delivery would issue, in base units. */
  requestedTokens: bigint;
}

/**
 * §6: "No delivery amount can exceed the instrument's available portion less
 * prior deliveries."
 *
 * The approve route took `deliveredAmountBaseUnits` from a reviewer and wrote a
 * vesting schedule for it, with nothing comparing the number to the holder's
 * portion. A mistyped exponent would have created a schedule for more tokens
 * than the instrument entitles, and the conservation check inside the schedule
 * (`sum(monthly) == delivered`) would still have passed — it checks the
 * schedule against itself, not against the entitlement.
 *
 * Integer base units only, and every input must be non-negative: a `-1` that
 * slipped through as a BigInt would make `requested <= available` true for a
 * negative request.
 */
export function deliveryQuantityGate(input: DeliveryQuantityInput): GateResult {
  const reasons: GateReason[] = [];
  const prior = input.priorDeliveredTokens ?? 0n;

  if (input.holderPortionTokens < 0n) {
    reasons.push({ code: "negative_portion", detail: "the holder's portion is negative" });
    return { ok: false, reasons };
  }
  if (prior < 0n) {
    reasons.push({ code: "negative_prior_delivery", detail: "prior deliveries total a negative amount" });
    return { ok: false, reasons };
  }
  if (input.requestedTokens < 0n) {
    reasons.push({ code: "negative_amount", detail: "the requested delivery is negative" });
    return { ok: false, reasons };
  }
  if (prior > input.holderPortionTokens) {
    reasons.push({
      code: "portion_already_exceeded",
      detail: `prior deliveries (${prior}) already exceed the portion (${input.holderPortionTokens})`,
    });
    return { ok: false, reasons };
  }

  const available = input.holderPortionTokens - prior;
  if (input.requestedTokens > available) {
    reasons.push({
      code: "portion_exceeded",
      detail: `requested ${input.requestedTokens} exceeds the available portion ${available}`,
    });
  }
  return { ok: reasons.length === 0, reasons };
}

/** What is left to deliver, computed with the same guards as the gate. */
export function availableDeliveryPortion(input: Omit<DeliveryQuantityInput, "requestedTokens">): bigint {
  const prior = input.priorDeliveredTokens ?? 0n;
  if (input.holderPortionTokens < 0n || prior < 0n || prior > input.holderPortionTokens) return 0n;
  return input.holderPortionTokens - prior;
}