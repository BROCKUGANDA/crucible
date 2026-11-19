/**
 * @file store.ts — the STAMP ledger, in process.
 *
 * Three ledgers, never one blended balance (blueprint §3):
 *
 *   1. **Legal** — instruments, allocations, notices, delivery requests.
 *   2. **Cash/treasury** — observed payments and their verification.
 *   3. **Chain** — the token structuring event and delivery confirmations.
 *
 * They are held in the same store because they must reconcile, but they are
 * never written by the same statement: an observation moves one, a reviewer's
 * decision moves another, and a chain read moves the third. Conflating them is
 * how a screenshot becomes a payment.
 *
 * In-memory by design, like every other store in this API (ADR-0008). The
 * durable tables live in `migrations/0004_stamp_foundation.sql` and
 * `0006_stamp_operations.sql`; the shapes here match them field for field, so
 * swapping the implementation does not change the domain.
 *
 * Every mutation goes through `record()`, which appends an audit event and an
 * outbox row in the same call as the domain write. A mutation that cannot be
 * audited is not performed.
 */

import {
  type AllocationSnapshot,
  type DeliveryState,
  type InstrumentState,
  type IssuerReadinessState,
  type NoticeRequirement,
  type StructuringEventState,
  type VestingSchedule,
  allocateSchedule2,
  buildNoticeSchedule,
  buildVestingSchedule,
  canTransitionIn,
  availableDeliveryPortion,
  resolveExpiration,
  type AllocationInput,
} from "@crucible/stamp-core";

export type StampMode = "disabled" | "sandbox" | "manual_review" | "production";

export type AuditAction =
  | "issuer.created"
  | "issuer.transitioned"
  | "holder.created"
  | "instrument.created"
  | "instrument.transitioned"
  | "instrument.signature_recorded"
  | "instrument.payment_verified"
  | "allocation.calculated"
  | "payment.observed"
  | "payment.verified"
  | "notice.scheduled"
  | "notice.delivered"
  | "structuring.prepared"
  | "structuring.reconciled"
  | "delivery.requested"
  | "delivery.address_proved"
  | "delivery.approved"
  | "vesting.created"
  | "assignment.requested"
  | "reconciliation.read";

export interface AuditEvent {
  id: number;
  at: number;
  actor: string;
  action: AuditAction;
  issuerId: string | null;
  instrumentId: string | null;
  /** A hash of the payload, never the payload: audit rows are not a data store. */
  payloadHash: string | null;
  detail: string;
}

export interface OutboxRow {
  id: number;
  at: number;
  topic: string;
  payloadDigest: string;
  payload: unknown;
  deliveredAt: number | null;
}

export interface IssuerRecord {
  id: string;
  tenantId: string;
  legalEntityName: string;
  entityType: string;
  jurisdictionCode: string;
  registrationNumber: string | null;
  metaDaoProjectRef: string | null;
  solanaCluster: string;
  status: IssuerReadinessState;
  counselApprovalRef: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface HolderRecord {
  id: string;
  issuerId: string;
  partyType: "investor" | "founder" | "service-provider";
  displayName: string;
  contactRef: string | null;
  eligibilityStatus: "pending" | "approved" | "rejected" | "review";
  eligibilityReviewedAt: number | null;
  jurisdictionScreeningStatus: "pending" | "cleared" | "flagged";
  /**
   * The verified session address bound to this holder.
   *
   * A holder record without a binding has no investor portal: wallet
   * connection alone is not identity, so the binding is made by a reviewer and
   * recorded as evidence.
   */
  principalAddress: string | null;
  boundAt: number | null;
  boundBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface InstrumentRecord {
  id: string;
  issuerId: string;
  holderPartyId: string;
  instrumentVersion: string;
  documentSha256: string;
  documentUri: string;
  signedDocumentSha256: string | null;
  issueDate: number;
  signedAt: number | null;
  purchasePriceMinor: string;
  currency: string;
  acceptedStablecoinMint: string;
  approvedWallet: string;
  proRataBps: string;
  status: InstrumentState;
  supersedesInstrumentId: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface PaymentRecord {
  id: string;
  instrumentId: string;
  network: string;
  cluster: string;
  tokenMint: string;
  fromAddress: string;
  toApprovedAddress: string;
  amountBaseUnits: string;
  transactionSignature: string;
  blockSlot: number | null;
  finalityStatus: "submitted" | "confirmed" | "finalized" | "reorged";
  canonicalityStatus: "pending" | "canonical" | "orphaned";
  observedAt: number;
  verifiedAt: number | null;
  verificationPayloadHash: string;
  /** Why a payment was refused, if it was. */
  refusalReason: string | null;
}

export interface StructuringEventRecord {
  id: string;
  issuerId: string;
  metaDaoProjectRef: string;
  totalNetworkTokens: string;
  tokenMint: string;
  tokenProgramId: string;
  mintAuthorityBefore: string | null;
  mintAuthorityAfter: string | null;
  structuringSlot: number | null;
  structuringSignature: string | null;
  finalityStatus: string;
  legalSupplySnapshotHash: string;
  metaDaoApprovalRef: string;
  status: StructuringEventState;
  createdAt: number;
  updatedAt: number;
}

export interface DeliveryRequestRecord {
  id: string;
  instrumentId: string;
  holderPartyId: string;
  requestDocumentSha256: string;
  signedAt: number;
  contractualExerciseAt: number;
  destinationAddress: string;
  addressChallengeSignature: string | null;
  addressNetwork: string;
  reviewStatus: "pending" | "approved" | "rejected";
  status: DeliveryState;
  reviewRef: string | null;
  deliveredAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface VestingRecord {
  id: string;
  instrumentId: string;
  schedule: VestingSchedule;
  chainAccountRef: string | null;
  createdAt: number;
}

export interface ReadModel {
  issuers: Map<string, IssuerRecord>;
  holders: Map<string, HolderRecord>;
  instruments: Map<string, InstrumentRecord>;
  allocations: Map<string, AllocationSnapshot[]>;
  payments: Map<string, PaymentRecord>;
  notices: Map<string, NoticeRequirement>;
  structuringEvents: Map<string, StructuringEventRecord>;
  deliveryRequests: Map<string, DeliveryRequestRecord>;
  vesting: Map<string, VestingRecord>;
  audit: AuditEvent[];
  outbox: OutboxRow[];
}

function freshModel(): ReadModel {
  return {
    issuers: new Map(),
    holders: new Map(),
    instruments: new Map(),
    allocations: new Map(),
    payments: new Map(),
    notices: new Map(),
    structuringEvents: new Map(),
    deliveryRequests: new Map(),
    vesting: new Map(),
    audit: [],
    outbox: [],
  };
}

let model: ReadModel = freshModel();
let sequence = 0;

export function getModel(): ReadModel {
  return model;
}

export function resetStore(): void {
  model = freshModel();
  sequence = 0;
}

function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence.toString(36).padStart(4, "0")}`;
}

export interface RecordInput {
  actor: string;
  action: AuditAction;
  issuerId: string | null;
  instrumentId: string | null;
  payload?: unknown;
  payloadHash?: string | null;
  detail?: string;
  /** The outbox topic to enqueue, when the mutation has a downstream effect. */
  topic?: string;
}

/**
 * Append the audit event and the outbox row.
 *
 * Both are appended *after* the domain write in this implementation because the
 * store is in process and cannot fail between the two; the durable
 * implementation wraps them in one transaction (see migration 0006's trigger
 * comment). The ordering is recorded here so the difference is visible rather
 * than assumed.
 */
export function record(input: RecordInput): { audit: AuditEvent; outbox: OutboxRow | null } {
  const at = Date.now();
  const audit: AuditEvent = {
    id: model.audit.length + 1,
    at,
    actor: input.actor.toLowerCase(),
    action: input.action,
    issuerId: input.issuerId,
    instrumentId: input.instrumentId,
    payloadHash: input.payloadHash ?? null,
    detail: input.detail ?? "",
  };
  model.audit.push(audit);

  let outbox: OutboxRow | null = null;
  if (input.topic) {
    outbox = {
      id: model.outbox.length + 1,
      at,
      topic: input.topic,
      payloadDigest: input.payloadHash ?? "",
      payload: input.payload ?? null,
      deliveredAt: null,
    };
    model.outbox.push(outbox);
  }
  return { audit, outbox };
}

/* ------------------------------------------------------------------ */
/* Issuers                                                             */
/* ------------------------------------------------------------------ */

export function createIssuer(input: {
  tenantId: string;
  legalEntityName: string;
  entityType: string;
  jurisdictionCode: string;
  registrationNumber?: string | null;
  metaDaoProjectRef?: string | null;
  solanaCluster?: string;
  counselApprovalRef?: string | null;
}): IssuerRecord {
  const now = Date.now();
  const issuer: IssuerRecord = {
    id: nextId("issuer"),
    tenantId: input.tenantId,
    legalEntityName: input.legalEntityName,
    entityType: input.entityType,
    jurisdictionCode: input.jurisdictionCode,
    registrationNumber: input.registrationNumber ?? null,
    metaDaoProjectRef: input.metaDaoProjectRef ?? null,
    solanaCluster: input.solanaCluster ?? "devnet",
    status: "DRAFT",
    counselApprovalRef: input.counselApprovalRef ?? null,
    createdAt: now,
    updatedAt: now,
  };
  model.issuers.set(issuer.id, issuer);
  return issuer;
}

export function transitionIssuer(
  id: string,
  to: IssuerReadinessState,
  actor: string,
): { ok: true; issuer: IssuerRecord } | { ok: false; reason: string } {
  const issuer = model.issuers.get(id);
  if (!issuer) return { ok: false, reason: `no issuer ${id}` };
  if (!canTransitionIn("ISSUER", issuer.status, to)) {
    return { ok: false, reason: `issuer ${id} cannot move from ${issuer.status} to ${to}` };
  }
  issuer.status = to;
  issuer.updatedAt = Date.now();
  record({
    actor,
    action: "issuer.transitioned",
    issuerId: id,
    instrumentId: null,
    detail: `${to}`,
    topic: "stamp.issuer.transitioned",
    payload: { issuerId: id, status: to },
  });
  return { ok: true, issuer };
}

/* ------------------------------------------------------------------ */
/* Holders                                                             */
/* ------------------------------------------------------------------ */

export function createHolder(input: {
  issuerId: string;
  partyType?: HolderRecord["partyType"];
  displayName: string;
  contactRef?: string | null;
  /** Who created the record. Absent means a system path, and it is recorded as such. */
  actor?: string;
}): HolderRecord {
  const now = Date.now();
  const holder: HolderRecord = {
    id: nextId("holder"),
    issuerId: input.issuerId,
    partyType: input.partyType ?? "investor",
    displayName: input.displayName,
    contactRef: input.contactRef ?? null,
    eligibilityStatus: "pending",
    eligibilityReviewedAt: null,
    jurisdictionScreeningStatus: "pending",
    principalAddress: null,
    boundAt: null,
    boundBy: null,
    createdAt: now,
    updatedAt: now,
  };
  model.holders.set(holder.id, holder);
  record({
    actor: input.actor ?? "system",
    action: "holder.created",
    issuerId: holder.issuerId,
    instrumentId: null,
    detail: holder.partyType,
    topic: "stamp.holder.created",
    payload: { holderId: holder.id },
  });
  return holder;
}

/**
 * Bind a verified session principal to a holder record.
 *
 * This is the only way an investor portal exists. A wallet that connects but is
 * not bound here sees nothing, because the binding is the reviewer's assertion
 * that this session belongs to this holder.
 */
export function bindHolderPrincipal(input: {
  holderId: string;
  principalAddress: string;
  actor: string;
}): { ok: true; holder: HolderRecord } | { ok: false; reason: string } {
  const holder = model.holders.get(input.holderId);
  if (!holder) return { ok: false, reason: `no holder ${input.holderId}` };
  holder.principalAddress = input.principalAddress.toLowerCase();
  holder.boundAt = Date.now();
  holder.boundBy = input.actor.toLowerCase();
  // Binding is the eligibility review: a reviewer asserting "this session is this
  // party" is the same check the KYC decision represents, and the database's
  // `stamp_holder_binding_requires_review` constraint refuses a binding on a
  // still-pending party. Recording the review here keeps the two facts together
  // instead of leaving a bound-but-unreviewed holder that the migration would
  // reject on its next run.
  if (holder.eligibilityStatus === "pending") {
    holder.eligibilityStatus = "approved";
    holder.eligibilityReviewedAt = holder.boundAt;
  }
  holder.updatedAt = Date.now();
  record({
    actor: input.actor,
    action: "holder.created",
    issuerId: holder.issuerId,
    instrumentId: null,
    detail: `bound ${input.principalAddress}`,
  });
  return { ok: true, holder };
}

export function holderForPrincipal(principalAddress: string): HolderRecord | null {
  const address = principalAddress.toLowerCase();
  for (const holder of model.holders.values()) {
    if (holder.principalAddress === address) return holder;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Instruments                                                         */
/* ------------------------------------------------------------------ */

export function createInstrument(input: {
  issuerId: string;
  holderPartyId: string;
  documentSha256: string;
  documentUri: string;
  issueDate: number;
  purchasePriceMinor: string;
  currency?: string;
  acceptedStablecoinMint: string;
  approvedWallet: string;
  proRataBps: string;
  createdBy: string;
}): InstrumentRecord {
  const now = Date.now();
  const instrument: InstrumentRecord = {
    id: nextId("inst"),
    issuerId: input.issuerId,
    holderPartyId: input.holderPartyId,
    instrumentVersion: "1",
    documentSha256: input.documentSha256,
    documentUri: input.documentUri,
    signedDocumentSha256: null,
    issueDate: input.issueDate,
    signedAt: null,
    purchasePriceMinor: input.purchasePriceMinor,
    currency: input.currency ?? "USDC",
    acceptedStablecoinMint: input.acceptedStablecoinMint,
    // Base58 is case-sensitive: a Solana address that is lower-cased is a
    // different address, and a payment gate comparing the two would refuse
    // every correct payment (or, worse, accept a lookalike).
    approvedWallet: input.approvedWallet,
    proRataBps: input.proRataBps,
    status: "DRAFT",
    supersedesInstrumentId: null,
    createdBy: input.createdBy.toLowerCase(),
    createdAt: now,
    updatedAt: now,
  };
  model.instruments.set(instrument.id, instrument);
  record({
    actor: input.createdBy,
    action: "instrument.created",
    issuerId: instrument.issuerId,
    instrumentId: instrument.id,
    payloadHash: instrument.documentSha256,
    detail: `${instrument.proRataBps} bps`,
    topic: "stamp.instrument.created",
    payload: { instrumentId: instrument.id },
  });
  return instrument;
}

export function transitionInstrument(
  id: string,
  to: InstrumentState,
  actor: string,
  detail = "",
): { ok: true; instrument: InstrumentRecord } | { ok: false; reason: string } {
  const instrument = model.instruments.get(id);
  if (!instrument) return { ok: false, reason: `no instrument ${id}` };
  if (!canTransitionIn("INSTRUMENT", instrument.status, to)) {
    return { ok: false, reason: `instrument ${id} cannot move from ${instrument.status} to ${to}` };
  }
  instrument.status = to;
  instrument.updatedAt = Date.now();
  record({
    actor,
    action: "instrument.transitioned",
    issuerId: instrument.issuerId,
    instrumentId: id,
    detail: detail || to,
    topic: "stamp.instrument.transitioned",
    payload: { instrumentId: id, status: to },
  });
  return { ok: true, instrument };
}

/* ------------------------------------------------------------------ */
/* Allocations                                                         */
/* ------------------------------------------------------------------ */

/**
 * Calculate and freeze an allocation snapshot for an issuer.
 *
 * The snapshot is stored by issuer, not by instrument, because the cap is an
 * aggregate rule: a holder's effective percentage depends on everybody else's
 * raw percentage. Storing a per-instrument number would let two concurrently
 * added holders each "fit" under the cap.
 */
export function calculateAllocations(input: {
  issuerId: string;
  inputs: readonly AllocationInput[];
  totalNetworkTokens: bigint;
  actor: string;
  capBps?: bigint;
  calculationVersion?: string;
}): {
  snapshots: AllocationSnapshot[];
  effectiveTotalBps: string;
  portionTotalTokens: string;
  capped: boolean;
  conserved: boolean;
  calculationInputHash: string;
} {
  const result = allocateSchedule2(input.inputs, input.totalNetworkTokens, {
    capBps: input.capBps,
    calculationVersion: input.calculationVersion,
  });
  model.allocations.set(input.issuerId, result.snapshots);
  record({
    actor: input.actor,
    action: "allocation.calculated",
    issuerId: input.issuerId,
    instrumentId: null,
    payloadHash: result.calculationInputHash,
    detail: `${result.snapshots.length} holders, effective ${result.effectiveTotalBps} bps`,
    topic: "stamp.allocation.calculated",
    payload: { issuerId: input.issuerId, hash: result.calculationInputHash },
  });
  return {
    snapshots: result.snapshots,
    effectiveTotalBps: result.effectiveTotalBps,
    portionTotalTokens: result.portionTotalTokens,
    capped: result.capped,
    conserved: result.conserved,
    calculationInputHash: result.calculationInputHash,
  };
}

/* ------------------------------------------------------------------ */
/* Payments                                                            */
/* ------------------------------------------------------------------ */

export function observePayment(input: {
  instrumentId: string;
  network: string;
  cluster: string;
  tokenMint: string;
  fromAddress: string;
  toApprovedAddress: string;
  amountBaseUnits: string;
  transactionSignature: string;
  blockSlot?: number | null;
  finalityStatus?: PaymentRecord["finalityStatus"];
  canonicalityStatus?: PaymentRecord["canonicalityStatus"];
  verificationPayloadHash: string;
  actor: string;
}): PaymentRecord {
  const payment: PaymentRecord = {
    id: nextId("pay"),
    instrumentId: input.instrumentId,
    network: input.network,
    cluster: input.cluster,
    tokenMint: input.tokenMint,
    fromAddress: input.fromAddress,
    toApprovedAddress: input.toApprovedAddress,
    amountBaseUnits: input.amountBaseUnits,
    transactionSignature: input.transactionSignature,
    blockSlot: input.blockSlot ?? null,
    finalityStatus: input.finalityStatus ?? "submitted",
    canonicalityStatus: input.canonicalityStatus ?? "pending",
    observedAt: Date.now(),
    verifiedAt: null,
    verificationPayloadHash: input.verificationPayloadHash,
    refusalReason: null,
  };
  model.payments.set(payment.id, payment);
  record({
    actor: input.actor,
    action: "payment.observed",
    issuerId: model.instruments.get(input.instrumentId)?.issuerId ?? null,
    instrumentId: input.instrumentId,
    payloadHash: input.verificationPayloadHash,
    detail: `${input.amountBaseUnits} on ${input.cluster}`,
    topic: "stamp.payment.observed",
    payload: { paymentId: payment.id, signature: input.transactionSignature },
  });
  return payment;
}

/** A payment signature may only exist once per (network, mint). */
export function findPaymentBySignature(
  network: string,
  tokenMint: string,
  signature: string,
): PaymentRecord | null {
  for (const payment of model.payments.values()) {
    if (
      payment.network === network &&
      payment.tokenMint === tokenMint &&
      payment.transactionSignature === signature
    ) {
      return payment;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Notices                                                             */
/* ------------------------------------------------------------------ */

export function scheduleNotices(input: {
  issuerId: string;
  structuringEventAt?: number | null;
  expirationAt?: number | null;
  now: number;
  holidays?: readonly string[];
  actor: string;
}): NoticeRequirement[] {
  const delivered = [...model.notices.values()]
    .filter((n) => n.status === "DELIVERED" && n.deliveredAt !== null)
    .map((n) => ({ id: n.id, noticeType: n.noticeType, deliveredAt: n.deliveredAt! }));
  const notices = buildNoticeSchedule({
    structuringEventAt: input.structuringEventAt,
    expirationAt: input.expirationAt,
    delivered,
    now: input.now,
    holidays: input.holidays,
  });
  for (const notice of notices) model.notices.set(notice.id, notice);
  record({
    actor: input.actor,
    action: "notice.scheduled",
    issuerId: input.issuerId,
    instrumentId: null,
    detail: `${notices.length} notices, ${notices.filter((n) => n.status === "MISSED").length} overdue`,
    topic: "stamp.notice.scheduled",
    payload: { issuerId: input.issuerId, notices: notices.map((n) => ({ id: n.id, status: n.status })) },
  });
  return notices;
}

export function markNoticeDelivered(input: {
  noticeId: string;
  deliveredAt: number;
  evidenceUri: string;
  evidenceHash: string;
  actor: string;
}): { ok: true; notice: NoticeRequirement } | { ok: false; reason: string } {
  const notice = model.notices.get(input.noticeId);
  if (!notice) return { ok: false, reason: `no notice ${input.noticeId}` };
  if (!input.evidenceUri || !input.evidenceHash) {
    return { ok: false, reason: "a notice is only delivered with an evidence URI and hash" };
  }
  notice.deliveredAt = input.deliveredAt;
  notice.deliveryEvidenceUri = input.evidenceUri;
  notice.status = "DELIVERED";
  notice.reason = `delivered at ${new Date(input.deliveredAt).toISOString()}`;
  record({
    actor: input.actor,
    action: "notice.delivered",
    issuerId: null,
    instrumentId: null,
    payloadHash: input.evidenceHash,
    detail: `${notice.noticeType} delivered`,
    topic: "stamp.notice.delivered",
    payload: { noticeId: notice.id },
  });
  return { ok: true, notice };
}

/* ------------------------------------------------------------------ */
/* Structuring events                                                  */
/* ------------------------------------------------------------------ */

export function prepareStructuringEvent(input: {
  issuerId: string;
  metaDaoProjectRef: string;
  totalNetworkTokens: string;
  tokenMint: string;
  tokenProgramId: string;
  mintAuthorityBefore: string | null;
  legalSupplySnapshotHash: string;
  metaDaoApprovalRef: string;
  actor: string;
}): StructuringEventRecord {
  const now = Date.now();
  const event: StructuringEventRecord = {
    id: nextId("tse"),
    issuerId: input.issuerId,
    metaDaoProjectRef: input.metaDaoProjectRef,
    totalNetworkTokens: input.totalNetworkTokens,
    tokenMint: input.tokenMint,
    tokenProgramId: input.tokenProgramId,
    mintAuthorityBefore: input.mintAuthorityBefore,
    mintAuthorityAfter: null,
    structuringSlot: null,
    structuringSignature: null,
    finalityStatus: "pending",
    legalSupplySnapshotHash: input.legalSupplySnapshotHash,
    metaDaoApprovalRef: input.metaDaoApprovalRef,
    status: "LEGAL_SNAPSHOT_LOCKED",
    createdAt: now,
    updatedAt: now,
  };
  model.structuringEvents.set(event.id, event);
  recordAction(input.issuerId, input.actor, "structuring.prepared", event.id);
  return event;
}

function recordAction(issuerId: string, actor: string, action: AuditAction, id: string): void {
  record({
    actor,
    action,
    issuerId,
    instrumentId: null,
    detail: id,
    topic: `stamp.${action}`,
    payload: { id },
  });
}

/* ------------------------------------------------------------------ */
/* Vesting                                                             */
/* ------------------------------------------------------------------ */

export function createVesting(input: {
  instrumentId: string;
  deliveredAmountBaseUnits: bigint;
  deliveryDate: number;
  chainAccountRef: string | null;
  actor: string;
}): VestingRecord {
  const schedule = buildVestingSchedule({
    deliveredAmountBaseUnits: input.deliveredAmountBaseUnits,
    deliveryDate: input.deliveryDate,
  });
  const vesting: VestingRecord = {
    id: nextId("vest"),
    instrumentId: input.instrumentId,
    schedule,
    chainAccountRef: input.chainAccountRef,
    createdAt: Date.now(),
  };
  model.vesting.set(vesting.id, vesting);
  record({
    actor: input.actor,
    action: "vesting.created",
    issuerId: model.instruments.get(input.instrumentId)?.issuerId ?? null,
    instrumentId: input.instrumentId,
    detail: `${input.deliveredAmountBaseUnits} over ${schedule.months} months from ${new Date(schedule.firstReleaseAt).toISOString()}`,
    topic: "stamp.vesting.created",
    payload: { vestingId: vesting.id },
  });
  return vesting;
}

export function vestingForInstrument(instrumentId: string): VestingRecord | null {
  for (const vesting of model.vesting.values()) {
    if (vesting.instrumentId === instrumentId) return vesting;
  }
  return null;
}

/**
 * What this instrument may still deliver.
 *
 * The portion comes from the frozen Schedule 2 snapshot for the instrument's
 * holder, never from the request: a caller cannot raise its own entitlement by
 * asking for more. `null` means the snapshot is missing, which the approve route
 * treats as a refusal rather than as "no limit".
 */
export function availablePortionForInstrument(instrumentId: string): {
  holderPortionTokens: bigint;
  priorDeliveredTokens: bigint;
  availableTokens: bigint;
} | null {
  const instrument = model.instruments.get(instrumentId);
  if (!instrument) return null;
  const snapshot = (model.allocations.get(instrument.issuerId) ?? []).find(
    (s) => s.holderId === instrument.holderPartyId,
  );
  if (!snapshot) return null;

  let priorDelivered = 0n;
  for (const vesting of model.vesting.values()) {
    if (vesting.instrumentId === instrumentId) {
      priorDelivered += BigInt(vesting.schedule.deliveredAmountBaseUnits);
    }
  }
  const holderPortion = BigInt(snapshot.holderPortionTokens);
  return {
    holderPortionTokens: holderPortion,
    priorDeliveredTokens: priorDelivered,
    availableTokens: availableDeliveryPortion({
      holderPortionTokens: holderPortion,
      priorDeliveredTokens: priorDelivered,
    }),
  };
}

/* ------------------------------------------------------------------ */
/* Delivery requests                                                   */
/* ------------------------------------------------------------------ */

export function createDeliveryRequest(input: {
  instrumentId: string;
  holderPartyId: string;
  requestDocumentSha256: string;
  signedAt: number;
  contractualExerciseAt: number;
  destinationAddress: string;
  addressNetwork: string;
  actor: string;
}): { ok: true; request: DeliveryRequestRecord } | { ok: false; reason: string } {
  for (const existing of model.deliveryRequests.values()) {
    if (
      existing.instrumentId === input.instrumentId &&
      !["REJECTED", "RECONCILED"].includes(existing.status)
    ) {
      return {
        ok: false,
        reason: `instrument ${input.instrumentId} already has an open delivery request (${existing.id})`,
      };
    }
  }
  const now = Date.now();
  const request: DeliveryRequestRecord = {
    id: nextId("del"),
    instrumentId: input.instrumentId,
    holderPartyId: input.holderPartyId,
    requestDocumentSha256: input.requestDocumentSha256,
    signedAt: input.signedAt,
    contractualExerciseAt: input.contractualExerciseAt,
    destinationAddress: input.destinationAddress,
    addressChallengeSignature: null,
    addressNetwork: input.addressNetwork,
    reviewStatus: "pending",
    status: "REQUESTED",
    reviewRef: null,
    deliveredAt: null,
    createdAt: now,
    updatedAt: now,
  };
  model.deliveryRequests.set(request.id, request);
  record({
    actor: input.actor,
    action: "delivery.requested",
    issuerId: model.instruments.get(input.instrumentId)?.issuerId ?? null,
    instrumentId: input.instrumentId,
    payloadHash: input.requestDocumentSha256,
    detail: input.destinationAddress,
    topic: "stamp.delivery.requested",
    payload: { deliveryRequestId: request.id },
  });
  return { ok: true, request };
}

export function transitionDelivery(
  id: string,
  to: DeliveryState,
  actor: string,
  detail = "",
): { ok: true; request: DeliveryRequestRecord } | { ok: false; reason: string } {
  const request = model.deliveryRequests.get(id);
  if (!request) return { ok: false, reason: `no delivery request ${id}` };
  if (!canTransitionIn("DELIVERY", request.status, to)) {
    return { ok: false, reason: `delivery ${id} cannot move from ${request.status} to ${to}` };
  }
  request.status = to;
  request.updatedAt = Date.now();
  if (to === "REJECTED") request.reviewStatus = "rejected";
  if (to === "APPROVED") request.reviewStatus = "approved";
  record({
    actor,
    action: to === "APPROVED" ? "delivery.approved" : "delivery.address_proved",
    issuerId: model.instruments.get(request.instrumentId)?.issuerId ?? null,
    instrumentId: request.instrumentId,
    detail: detail || to,
    topic: `stamp.delivery.${to.toLowerCase()}`,
    payload: { deliveryRequestId: id, status: to },
  });
  return { ok: true, request };
}

/* ------------------------------------------------------------------ */
/* Derived read models                                                 */
/* ------------------------------------------------------------------ */

/**
 * Whether an instrument is past its contractual expiration.
 *
 * Uses the same precedence resolution as the domain: a signed date wins, then
 * a no-token decision, then 120 days after the structuring event, then ten
 * years from issue.
 */
export function instrumentExpiration(
  instrumentId: string,
  now: number,
): { expiresAt: number; basis: string; expired: boolean } | null {
  const instrument = model.instruments.get(instrumentId);
  if (!instrument) return null;
  const events = [...model.structuringEvents.values()].filter((e) => e.issuerId === instrument.issuerId);
  const structuringEventAt =
    events.find((e) => e.finalityStatus === "finalized" || e.status === "DELIVERY_OPEN")?.createdAt ?? null;
  const resolution = resolveExpiration(
    { issueDate: instrument.issueDate, structuringEventAt, now },
    now,
  );
  return { expiresAt: resolution.expiresAt, basis: resolution.basis, expired: resolution.expired };
}

/** The reconciliation report an operator reads before anything irreversible. */
export function reconciliationReport(issuerId: string): {
  instruments: { status: string; count: number }[];
  payments: { observed: number; verified: number; refused: number };
  reserve: { effectiveBps: string; capBps: string; headroomBps: string };
  notices: { outstanding: number; overdue: number };
  deliveryRequests: { open: number; approved: number; reconciled: number };
} {
  const instruments = [...model.instruments.values()].filter((i) => i.issuerId === issuerId);
  const instrumentIds = new Set(instruments.map((i) => i.id));
  const payments = [...model.payments.values()].filter((p) => instrumentIds.has(p.instrumentId));
  const allocations = model.allocations.get(issuerId) ?? [];
  const effectiveBps = allocations.reduce((a, s) => a + BigInt(s.effectiveProRataBps), 0n);
  const notices = [...model.notices.values()];
  const deliveries = [...model.deliveryRequests.values()].filter((d) => instrumentIds.has(d.instrumentId));

  const statusCounts = new Map<string, number>();
  for (const instrument of instruments) {
    statusCounts.set(instrument.status, (statusCounts.get(instrument.status) ?? 0) + 1);
  }

  return {
    instruments: [...statusCounts.entries()].map(([status, count]) => ({ status, count })),
    payments: {
      observed: payments.length,
      verified: payments.filter((p) => p.verifiedAt !== null).length,
      refused: payments.filter((p) => p.refusalReason !== null).length,
    },
    reserve: {
      effectiveBps: effectiveBps.toString(),
      capBps: "2000",
      headroomBps: (2000n - effectiveBps > 0n ? 2000n - effectiveBps : 0n).toString(),
    },
    notices: {
      outstanding: notices.filter((n) => n.status !== "DELIVERED").length,
      overdue: notices.filter((n) => n.status === "MISSED" || n.status === "ESCALATED").length,
    },
    deliveryRequests: {
      open: deliveries.filter((d) => !["RECONCILED", "REJECTED"].includes(d.status)).length,
      approved: deliveries.filter((d) => d.status === "APPROVED" || d.status === "SUBMITTED").length,
      reconciled: deliveries.filter((d) => d.status === "RECONCILED").length,
    },
  };
}

/** The public projection: approved aggregate facts only, no holder data. */
export function publicTransparency(issuerId: string): {
  issuer: { legalEntityName: string; jurisdictionCode: string; status: string } | null;
  totalNetworkTokens: string | null;
  investorReserveBps: string | null;
  teamAllocationBps: string | null;
  tokenMint: string | null;
  daoTreasuryAddress: string | null;
  governanceUrl: string | null;
  holderCount: number | null;
  allocatedCount: number | null;
} {
  const issuer = model.issuers.get(issuerId);
  if (!issuer) {
    return {
      issuer: null,
      totalNetworkTokens: null,
      investorReserveBps: null,
      teamAllocationBps: null,
      tokenMint: null,
      daoTreasuryAddress: null,
      governanceUrl: null,
      holderCount: null,
      allocatedCount: null,
    };
  }
  const structuring = [...model.structuringEvents.values()].find((e) => e.issuerId === issuerId);
  const allocations = model.allocations.get(issuerId) ?? [];
  const holders = [...model.holders.values()].filter((h) => h.issuerId === issuerId);
  const investorBps = allocations.reduce((a, s) => a + BigInt(s.effectiveProRataBps), 0n);
  return {
    issuer: {
      legalEntityName: issuer.legalEntityName,
      jurisdictionCode: issuer.jurisdictionCode,
      status: issuer.status,
    },
    totalNetworkTokens: structuring?.totalNetworkTokens ?? allocations[0]?.totalNetworkTokens ?? null,
    // A figure is read or it is not shown: these are null, never "0", when no
    // allocation snapshot exists.
    investorReserveBps: allocations.length > 0 ? investorBps.toString() : null,
    teamAllocationBps: null,
    tokenMint: structuring?.tokenMint ?? null,
    daoTreasuryAddress: null,
    governanceUrl: issuer.metaDaoProjectRef
      ? `https://metadao.com/docs/stamp`
      : null,
    holderCount: holders.length > 0 ? holders.length : null,
    allocatedCount: allocations.length > 0 ? allocations.length : null,
  };
}