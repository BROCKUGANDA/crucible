/**
 * The clock and the books of a trial — derived, in one pure place, from constants read off the
 * chain.
 *
 * `/clock` renders this. The whole point of keeping it separate and pure (the same reason
 * `ops.ts` is pure) is that every figure a judge sees is a *read*, and a figure that was not read
 * prints as the em dash rather than a number someone typed into a front end. A copied constant is
 * a constant that silently rots the day the contract changes; the contract is the only source.
 *
 * The numbers themselves never appear as literals in this file. `FEE_BPS` over `BPS`, the bond as
 * `BOND_NUM` over `BOND_DEN`, the skeptic floor as one over `BREAK_STAKE_DEN`, the committee as
 * `ARGUS_THRESHOLD` seats-of-`ARGUS_THRESHOLD + 1` — all are read by the host and handed in as
 * bigints. What this file owns is only the *mapping* from a read to a human sentence.
 *
 * ── the one rule, same as `ops.ts` ──────────────────────────────────────────────────────────
 * **Unread renders as unknown, never as zero.** `null` for a constant means the contract was not
 * reached (no deployment, wrong chain, a failed read) — which is a different sentence from a
 * constant whose value happens to be 0. Every row below carries the contract function(s) its
 * figure came from so the page can attribute it, and prints `UNKNOWN` when any of them is absent.
 */

import { formatDuration } from "./forge";
import { formatWei } from "./eth";

/** The site's "no measurement" glyph, shared with `ops.ts`, `formatEth` and `formatDuration`. */
export const UNKNOWN = "—";

/**
 * The CrucibleTrials functions this page reads. A `public constant` compiles to a getter of the
 * same name, so each entry is both the ABI function name and the label the page attributes.
 */
export const CLOCK_FUNCTIONS = [
  "FEE_BPS",
  "BPS",
  "BOND_NUM",
  "BOND_DEN",
  "BREAK_STAKE_DEN",
  "SLASH_SKEPTIC_NUM",
  "MIN_BOND",
  "MAX_REWARD",
  "MIN_RUN_WINDOW",
  "MIN_BREAK_WINDOW",
  "MAX_BREAK_WINDOW",
  "COMMIT_WINDOW",
  "DISPUTE_TIMEOUT",
  "ARGUS_THRESHOLD",
] as const;

export type ClockFunction = (typeof CLOCK_FUNCTIONS)[number];

/**
 * A read is present only when the contract answered. Absent (or `undefined`) means "not read",
 * which renders as `UNKNOWN`; a bigint `0n` means the contract genuinely holds 0 and prints as 0.
 */
export type ClockReads = Partial<Record<ClockFunction, bigint>>;

/** One labelled figure, with the chain functions it was derived from. */
export interface ClockRow {
  label: string;
  /** the rendered value, or `UNKNOWN` when it rests on a constant that was not read */
  value: string;
  /** the source line: which contract function(s) produced `value`, or why it could not */
  source: string;
  /** false when `value` is `UNKNOWN` — the page colours an unread row differently */
  read: boolean;
}

/**
 * A rate as a percentage, from a numerator and denominator both read off the chain.
 *
 * Exact on the way in (BigInt), then rendered to at most two decimals with trailing zeros
 * dropped — `500/10000` is `5%`, not `5.00%`, and not `0.05` dressed up as a decimal. This is a
 * rate for display, not a money amount; money never goes through a float anywhere in this app.
 */
function percentOf(num: bigint | undefined, den: bigint | undefined): string | null {
  if (num === undefined || den === undefined || den === 0n) return null;
  // num/den as a percentage = num*100/den. Keep two decimals of headroom, then trim.
  const scaled = (Number(num) * 100) / Number(den);
  if (!Number.isFinite(scaled)) return null;
  const rounded = Math.round(scaled * 100) / 100;
  return `${rounded}%`;
}

/** A duration constant (whole seconds) rendered through the shared countdown formatter. */
function durationOf(seconds: bigint | undefined): string | null {
  if (seconds === undefined) return null;
  const n = Number(seconds);
  if (!Number.isSafeInteger(n)) return null;
  return formatDuration(n);
}

/** A wei ceiling/floor rendered as ETH through the one repo formatter (exact; display only). */
function ethOf(wei: bigint | undefined): string | null {
  if (wei === undefined) return null;
  return `${formatWei(wei)} ETH`;
}

/** Build a row whose value comes from one builder over named sources. */
function row(
  label: string,
  sources: ClockFunction[],
  value: string | null,
): ClockRow {
  const source =
    value === null ? `not read: ${sources.map(sourceName).join(" + ")}` : `from ${sources.map(sourceName).join(" + ")}`;
  return { label, value: value ?? UNKNOWN, source, read: value !== null };
}

/** The getter name the chain exposes for a constant, so the attribution is verifiable. */
function sourceName(name: ClockFunction): string {
  return `CrucibleTrials.${name}()`;
}

/**
 * The clock: how long each phase of a trial can run, and the committee's thresholds. Everything
 * is a duration or a seat count the contract owns; the prose that turns it into "why a challenge
 * takes this long" lives in the page, keyed to these rows.
 */
export function deriveClock(reads: ClockReads): {
  phases: ClockRow[];
  committee: ClockRow[];
} {
  const skepticMin = durationOf(reads.MIN_BREAK_WINDOW);
  const skepticMax = durationOf(reads.MAX_BREAK_WINDOW);
  const skepticRange =
    skepticMin !== null && skepticMax !== null ? `${skepticMin} to ${skepticMax}` : null;

  return {
    phases: [
      row(
        "Shortest submission window",
        ["MIN_RUN_WINDOW"],
        durationOf(reads.MIN_RUN_WINDOW),
      ),
      row(
        "Skeptic window, set per trial",
        ["MIN_BREAK_WINDOW", "MAX_BREAK_WINDOW"],
        skepticRange,
      ),
      row("Seat commit window", ["COMMIT_WINDOW"], durationOf(reads.COMMIT_WINDOW)),
      row(
        "Auto-settle after an un decided break",
        ["DISPUTE_TIMEOUT"],
        durationOf(reads.DISPUTE_TIMEOUT),
      ),
    ],
    committee: [
      row(
        "Votes needed to settle",
        ["ARGUS_THRESHOLD"],
        reads.ARGUS_THRESHOLD === undefined
          ? null
          : `${reads.ARGUS_THRESHOLD} of ${reads.ARGUS_THRESHOLD + 1n}`,
      ),
    ],
  };
}

/**
 * The books: what the protocol charges, what a claim costs, what a landing break pays. Every
 * figure is a ratio or an ETH amount read from the contract, never re-typed here.
 */
export function deriveBooks(reads: ClockReads): ClockRow[] {
  // The bond is `BOND_NUM / BOND_DEN` of the reward; the skeptic's floor is one part in
  // `BREAK_STAKE_DEN` of the reward; a winning skeptic takes `SLASH_SKEPTIC_NUM / BPS` of the
  // bond; the treasury's fee on a payout is `FEE_BPS / BPS`.
  const treasuryFee = percentOf(reads.FEE_BPS, reads.BPS);
  const bondShare = percentOf(reads.BOND_NUM, reads.BOND_DEN);
  const skepticFloor = percentOf(1n, reads.BREAK_STAKE_DEN);
  const skepticCut = percentOf(reads.SLASH_SKEPTIC_NUM, reads.BPS);
  const treasuryCut =
    reads.SLASH_SKEPTIC_NUM !== undefined && reads.BPS !== undefined
      ? percentOf(reads.BPS - reads.SLASH_SKEPTIC_NUM, reads.BPS)
      : null;

  return [
    row("Reward floor", ["MIN_BOND"], ethOf(reads.MIN_BOND)),
    row("Reward ceiling", ["MAX_REWARD"], ethOf(reads.MAX_REWARD)),
    row("Agent's bond, share of the reward", ["BOND_NUM", "BOND_DEN"], bondShare),
    row("Skeptic's minimum stake, share of the reward", ["BREAK_STAKE_DEN"], skepticFloor),
    row("Settlement fee, to the treasury", ["FEE_BPS", "BPS"], treasuryFee),
    row("On a landing break: to the skeptic", ["SLASH_SKEPTIC_NUM", "BPS"], skepticCut),
    row("On a landing break: to the treasury", ["SLASH_SKEPTIC_NUM", "BPS"], treasuryCut),
  ];
}

/**
 * Whether the chain was reached at all. A page whose constants are every-`UNKNOWN` is not "a
 * deployment that charges nothing" — it is a page that could not read a deployment, and it has
 * to say that plainly (see the honesty rule on `/assay`).
 */
export function clockRead(reads: ClockReads): boolean {
  return CLOCK_FUNCTIONS.some((name) => reads[name] !== undefined);
}

/** A sentence for the case where nothing was read, in the forge's register. */
export function unreadNote(): string {
  return `No forge to read from. These are the chain's own numbers — not a deployment's, because this build has no contract address wired in — so each one is shown as ${UNKNOWN} rather than a number typed into the page.`;
}
