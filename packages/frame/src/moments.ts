/**
 * The moment detector.
 *
 * A replay is not a log dump: the reader needs to know which beats of a trial are worth
 * watching and which are noise. This file owns that decision once, so the rail, the money
 * flow and the commentary director cannot each invent their own idea of what happened.
 *
 * The labels are the words a visitor reads. They carry no numbers — figures come from the
 * frame's own books, formatted once at the surface — and no builder vocabulary: not
 * "RunSubmitted", not "31337", not "wei".
 */

export type MomentKind = "posted" | "claimed" | "submitted" | "broken" | "disputed" | "voting" | "settled";

export interface MomentInfo {
  kind: MomentKind;
  /** One line of plain English for the rail. */
  label: string;
  /**
   * Whether a commentary line is worth composing for this beat. Vote seals are deliberately
   * not speakable: a three-seat panel is three near-identical beats in a row, and a
   * commentator that narrates each one is noise that costs money.
   */
  speakable: boolean;
}

const MOMENTS: Record<MomentKind, MomentInfo> = {
  posted: {
    kind: "posted",
    label: "A sponsor put the prize on the table and asked for the work.",
    speakable: true,
  },
  claimed: {
    kind: "claimed",
    label: "An agent staked its own money and took the job.",
    speakable: true,
  },
  submitted: {
    kind: "submitted",
    label: "The run came in, hashed and signed.",
    speakable: true,
  },
  broken: {
    kind: "broken",
    label: "A skeptic paid for the chance to prove it wrong.",
    speakable: true,
  },
  disputed: {
    kind: "disputed",
    label: "Three seats were drawn to judge the claim.",
    speakable: true,
  },
  voting: {
    kind: "voting",
    label: "A seat recorded its answer.",
    speakable: false,
  },
  settled: {
    kind: "settled",
    label: "The chain decided.",
    speakable: true,
  },
};

export function momentInfo(kind: MomentKind): MomentInfo {
  return MOMENTS[kind];
}

/** Every event this detector knows, mapped to its beat. Unknown events are not frames. */
const EVENT_TO_MOMENT: Record<string, MomentKind> = {
  TrialCreated: "posted",
  TrialClaimed: "claimed",
  RunSubmitted: "submitted",
  BreakFiled: "broken",
  DisputeOpened: "disputed",
  VoteCommitted: "voting",
  VoteRevealed: "voting",
  VerdictFinalized: "settled",
};

export function momentOf(eventName: string): MomentKind | null {
  return EVENT_TO_MOMENT[eventName] ?? null;
}

/** The kinds a frame can hold, in the order a trial usually meets them. */
export const MOMENT_ORDER: readonly MomentKind[] = [
  "posted",
  "claimed",
  "submitted",
  "broken",
  "disputed",
  "voting",
  "settled",
];
