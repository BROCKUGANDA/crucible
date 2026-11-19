/**
 * @file state-machines.ts — the four STAMP state machines.
 *
 * The blueprint is explicit that these must be separate machines rather than one
 * `status` column, because they move on different clocks and are owned by
 * different actors:
 *
 *   - Issuer readiness moves on counsel and MetaDAO review.
 *   - The instrument lifecycle moves on signature, payment and delivery.
 *   - The token structuring event moves on the chain.
 *   - Delivery moves on the holder's request and the chain's finality.
 *
 * The rules that matter most are the ones the blueprint calls out by name:
 * `SIGNED` never means `FUNDED`, `FUNDED` never means tokens were minted, and
 * `DELIVERED` is not reached until chain delivery *and* ledger reconciliation
 * are both confirmed.
 */

/* ------------------------------------------------------------------ */
/* Issuer readiness                                                     */
/* ------------------------------------------------------------------ */

export type IssuerReadinessState =
  | "DRAFT"
  | "COUNSEL_REVIEW"
  | "ENTITY_READY"
  | "IP_PERIMETER_VERIFIED"
  | "META_DAO_REVIEW"
  | "LISTED"
  | "ACTIVE"
  | "LEGAL_HOLD"
  | "META_DAO_HOLD"
  | "WINDING_DOWN"
  | "REJECTED";

const ISSUER_TRANSITIONS: Record<IssuerReadinessState, IssuerReadinessState[]> = {
  DRAFT: ["COUNSEL_REVIEW", "REJECTED"],
  COUNSEL_REVIEW: ["ENTITY_READY", "LEGAL_HOLD", "REJECTED"],
  ENTITY_READY: ["IP_PERIMETER_VERIFIED", "LEGAL_HOLD", "REJECTED"],
  IP_PERIMETER_VERIFIED: ["META_DAO_REVIEW", "LEGAL_HOLD", "REJECTED"],
  META_DAO_REVIEW: ["LISTED", "META_DAO_HOLD", "LEGAL_HOLD", "REJECTED"],
  LISTED: ["ACTIVE", "META_DAO_HOLD", "LEGAL_HOLD"],
  ACTIVE: ["WINDING_DOWN", "LEGAL_HOLD", "META_DAO_HOLD"],
  LEGAL_HOLD: ["COUNSEL_REVIEW", "WINDING_DOWN", "REJECTED"],
  META_DAO_HOLD: ["META_DAO_REVIEW", "WINDING_DOWN", "REJECTED"],
  WINDING_DOWN: [],
  REJECTED: [],
};

/* ------------------------------------------------------------------ */
/* Instrument lifecycle                                                 */
/* ------------------------------------------------------------------ */

export type InstrumentState =
  | "DRAFT"
  | "COUNSEL_APPROVED"
  | "OFFERED"
  | "SIGNED"
  | "PAYMENT_PENDING"
  | "FUNDED"
  | "ELIGIBLE_FOR_DELIVERY"
  | "DELIVERY_REQUESTED"
  | "DELIVERY_APPROVED"
  | "DELIVERED"
  | "VESTING_ACTIVE"
  | "VESTING_COMPLETE"
  | "CANCELLED"
  | "EXPIRED"
  | "ASSIGNED"
  | "SUPERSEDED"
  | "DISPUTED"
  | "DISSOLUTION_CLAIM";

const INSTRUMENT_TRANSITIONS: Record<InstrumentState, InstrumentState[]> = {
  DRAFT: ["COUNSEL_APPROVED", "CANCELLED"],
  COUNSEL_APPROVED: ["OFFERED", "CANCELLED", "SUPERSEDED"],
  OFFERED: ["SIGNED", "CANCELLED", "EXPIRED", "SUPERSEDED"],
  SIGNED: ["PAYMENT_PENDING", "CANCELLED", "EXPIRED", "SUPERSEDED", "DISPUTED"],
  PAYMENT_PENDING: ["FUNDED", "CANCELLED", "EXPIRED", "DISPUTED"],
  FUNDED: ["ELIGIBLE_FOR_DELIVERY", "ASSIGNED", "CANCELLED", "EXPIRED", "DISPUTED", "DISSOLUTION_CLAIM"],
  ELIGIBLE_FOR_DELIVERY: ["DELIVERY_REQUESTED", "ASSIGNED", "EXPIRED", "DISPUTED", "DISSOLUTION_CLAIM"],
  DELIVERY_REQUESTED: ["DELIVERY_APPROVED", "ELIGIBLE_FOR_DELIVERY", "EXPIRED", "DISPUTED"],
  DELIVERY_APPROVED: ["DELIVERED", "ELIGIBLE_FOR_DELIVERY", "EXPIRED", "DISPUTED"],
  DELIVERED: ["VESTING_ACTIVE", "DISPUTED", "DISSOLUTION_CLAIM"],
  VESTING_ACTIVE: ["VESTING_COMPLETE", "DISPUTED", "DISSOLUTION_CLAIM"],
  VESTING_COMPLETE: ["DISPUTED", "DISSOLUTION_CLAIM"],
  CANCELLED: [],
  EXPIRED: [],
  ASSIGNED: [],
  SUPERSEDED: [],
  DISPUTED: ["ELIGIBLE_FOR_DELIVERY", "FUNDED", "DISSOLUTION_CLAIM"],
  DISSOLUTION_CLAIM: [],
};

/* ------------------------------------------------------------------ */
/* Token structuring event                                              */
/* ------------------------------------------------------------------ */

export type StructuringEventState =
  | "PREPARATION"
  | "LEGAL_SNAPSHOT_LOCKED"
  | "HOLDER_NOTICE_SENT"
  | "META_DAO_EVENT_SUBMITTED"
  | "CHAIN_CONFIRMED"
  | "FINALITY_CONFIRMED"
  | "PORTIONS_RECONCILED"
  | "DELIVERY_OPEN"
  | "HOLD";

const STRUCTURING_TRANSITIONS: Record<StructuringEventState, StructuringEventState[]> = {
  PREPARATION: ["LEGAL_SNAPSHOT_LOCKED", "HOLD"],
  LEGAL_SNAPSHOT_LOCKED: ["HOLDER_NOTICE_SENT", "HOLD"],
  HOLDER_NOTICE_SENT: ["META_DAO_EVENT_SUBMITTED", "HOLD"],
  META_DAO_EVENT_SUBMITTED: ["CHAIN_CONFIRMED", "HOLD"],
  CHAIN_CONFIRMED: ["FINALITY_CONFIRMED", "HOLD"],
  FINALITY_CONFIRMED: ["PORTIONS_RECONCILED", "HOLD"],
  PORTIONS_RECONCILED: ["DELIVERY_OPEN", "HOLD"],
  DELIVERY_OPEN: [],
  HOLD: ["PREPARATION", "HOLDER_NOTICE_SENT", "META_DAO_EVENT_SUBMITTED", "CHAIN_CONFIRMED"],
};

/* ------------------------------------------------------------------ */
/* Delivery lifecycle                                                   */
/* ------------------------------------------------------------------ */

export type DeliveryState =
  | "REQUESTED"
  | "SIGNATURE_VERIFIED"
  | "ADDRESS_VALIDATED"
  | "ELIGIBILITY_RECHECKED"
  | "APPROVED"
  | "SUBMITTED"
  | "CONFIRMED"
  | "RECONCILED"
  | "REJECTED";

const DELIVERY_TRANSITIONS: Record<DeliveryState, DeliveryState[]> = {
  REQUESTED: ["SIGNATURE_VERIFIED", "REJECTED"],
  SIGNATURE_VERIFIED: ["ADDRESS_VALIDATED", "REJECTED"],
  ADDRESS_VALIDATED: ["ELIGIBILITY_RECHECKED", "REJECTED"],
  ELIGIBILITY_RECHECKED: ["APPROVED", "REJECTED"],
  APPROVED: ["SUBMITTED", "REJECTED"],
  SUBMITTED: ["CONFIRMED", "REJECTED"],
  CONFIRMED: ["RECONCILED", "REJECTED"],
  RECONCILED: [],
  REJECTED: [],
};

export type AnyState =
  | IssuerReadinessState
  | InstrumentState
  | StructuringEventState
  | DeliveryState;

/**
 * The four machines, by name.
 *
 * The generic helpers below search every machine, which is the right answer
 * for "is this transition legal somewhere?" and the wrong answer for "what may
 * this instrument do next?". The machines share state names on purpose — an
 * instrument and an issuer are both DRAFT — so the per-machine functions are
 * the primary API and the generic ones are the fallback.
 */
export const MACHINES = {
  ISSUER: ISSUER_TRANSITIONS,
  INSTRUMENT: INSTRUMENT_TRANSITIONS,
  STRUCTURING: STRUCTURING_TRANSITIONS,
  DELIVERY: DELIVERY_TRANSITIONS,
} as const;

export type MachineName = keyof typeof MACHINES;

function machine(name: MachineName): Record<string, string[]> {
  return MACHINES[name] as unknown as Record<string, string[]>;
}

/** The legal successors of an issuer-readiness state. */
export function issuerNextStates(from: IssuerReadinessState): IssuerReadinessState[] {
  return (machine("ISSUER")[from] ?? []) as IssuerReadinessState[];
}

/** The legal successors of an instrument state. */
export function instrumentNextStates(from: InstrumentState): InstrumentState[] {
  return (machine("INSTRUMENT")[from] ?? []) as InstrumentState[];
}

/** The legal successors of a structuring-event state. */
export function structuringNextStates(from: StructuringEventState): StructuringEventState[] {
  return (machine("STRUCTURING")[from] ?? []) as StructuringEventState[];
}

/** The legal successors of a delivery state. */
export function deliveryNextStates(from: DeliveryState): DeliveryState[] {
  return (machine("DELIVERY")[from] ?? []) as DeliveryState[];
}

/** Is `from -> to` legal in the named machine? */
export function canTransitionIn(name: MachineName, from: string, to: string): boolean {
  return (machine(name)[from] ?? []).includes(to);
}

/**
 * Is `from -> to` a legal transition in any machine that owns `from`?
 *
 * A state name that exists in more than one machine (DRAFT, ACTIVE, HOLD) is
 * resolved by asking every machine that defines it.
 */
export function canTransition(from: AnyState, to: AnyState): boolean {
  for (const name of Object.keys(MACHINES) as MachineName[]) {
    if (from in machine(name) && (machine(name)[from] ?? []).includes(to)) return true;
  }
  return false;
}

/** The legal successors of a state, across every machine that defines it. */
export function nextStates(from: AnyState): AnyState[] {
  const out: string[] = [];
  for (const name of Object.keys(MACHINES) as MachineName[]) {
    for (const next of machine(name)[from] ?? []) {
      if (!out.includes(next)) out.push(next);
    }
  }
  return out as AnyState[];
}

/** A state with no successors in any machine that defines it. */
export function isTerminalState(state: AnyState): boolean {
  const owners = (Object.keys(MACHINES) as MachineName[]).filter((name) => state in machine(name));
  if (owners.length === 0) return true;
  return owners.every((name) => (machine(name)[state] ?? []).length === 0);
}

/**
 * Does this transition cross a legal boundary the blueprint forbids?
 *
 * `SIGNED` must never be read as `FUNDED`, `FUNDED` must never be read as
 * "tokens minted", and `DELIVERED` requires both chain confirmation and
 * reconciliation. A machine that let `FUNDED -> DELIVERED` would let an
 * unpaid instrument reach delivery.
 */
export function forbiddenShortcuts(): {
  from: AnyState;
  to: AnyState;
  machine: MachineName;
  reason: string;
}[] {
  return [
    {
      from: "SIGNED",
      to: "FUNDED",
      machine: "INSTRUMENT",
      reason: "a signed instrument is not a funded one; payment must be verified first",
    },
    {
      from: "SIGNED",
      to: "DELIVERED",
      machine: "INSTRUMENT",
      reason: "delivery requires a funded, eligible, requested and approved chain path",
    },
    {
      from: "FUNDED",
      to: "DELIVERED",
      machine: "INSTRUMENT",
      reason: "delivery requires an approved delivery request and a confirmed chain transaction",
    },
    {
      from: "DELIVERY_APPROVED",
      to: "RECONCILED",
      machine: "DELIVERY",
      reason: "reconciliation requires a confirmed chain transaction first",
    },
    {
      from: "SUBMITTED",
      to: "DELIVERED",
      machine: "DELIVERY",
      reason: "a submitted transaction is not a delivered one until finality is confirmed",
    },
  ];
}

/** The states that mean "the holder may be told the money arrived". */
export const FUNDED_STATES: readonly InstrumentState[] = ["FUNDED", "ELIGIBLE_FOR_DELIVERY"];