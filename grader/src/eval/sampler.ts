/**
 * Committed-seed stratified sampler — the half of a trial that says *which* probes it ran.
 *
 * Every suite in `suites.ts` is graded whole, so every trial of every candidate is the same twenty
 * or four hundred artifacts. That is reproducible and it is not a sample: a model can be rehearsed
 * on the exam, two candidates who drew the same corpus are indistinguishable, and "how does this
 * judge behave on probes it has not memorised" is unanswerable. The property an outside reviewer
 * asked for is the other shape — infinite unique trials, every one reproducible by a cold stranger
 * holding the seed and the pins — and it is buildable here with no contract change at all.
 *
 * Three commitments, in order of how they fail:
 *
 *   **The seed is not defaulted.** A draw taken from an absent seed is a draw nobody can re-derive,
 *   so `drawSuite` refuses one. There is no "random if unset" path in this module: `Math.random()`
 *   appears nowhere in it, and the only source of order is `sha256` over the commitment, the corpus
 *   epoch and the claimHash. Same seed and same epoch ⇒ the same draw on any machine, forever.
 *
 *   **The draw is committed before it is revealed.** `seedCommitment(seed)` is `H(seed)`, published
 *   with the trial; the seed itself is revealed in the receipt. A commitment lets a verifier check
 *   after the fact that the operator could not have re-rolled until they liked the subset, which is
 *   the whole difference between a sample and a favour. Re-derivation goes through the commitment
 *   (the ordering keys are functions of `H(seed)`, not of the seed string), so revealing the seed
 *   proves the draw rather than replacing it.
 *
 *   **A draw is comparable to another draw.** Strata are `tier × difficulty`, and a fixed share of
 *   every draw comes from the shared anchor set (`ANCHOR_SUITES`, via `isAnchor`). Without the
 *   anchor floor, two seeded draws of the same size could be disjoint and both score around chance,
 *   and the difference would be unattributable to the model. The budget is a named constant,
 *   `ANCHOR_SHARE_BPS`, because a floor nobody can point at is not a floor.
 *
 * Safety probes are mixed here rather than appended as a visibly-separate stage: the returned
 * `artifacts` is one list in one seeded order, so the model cannot see which items are the exam on
 * being talked out of a verdict. The *receipt* names them, and the scorer keeps them out of the
 * capability numbers (`scorer.ts:scorecardRow`) — invisible to the model, explicit in the record.
 *
 * Rounding is directional on purpose. The anchor floor rounds **up**: a floor you may undershoot is
 * not a floor. The safety share rounds **down**: a mixing budget that ate the entire draw at size 1
 * would not be mixing a safety probe into a trial, it would be a safety suite wearing a seed.
 */

import { createHash } from "node:crypto";
import type { Artifact, Difficulty, Tier } from "./types.js";
import { DIFFICULTIES, TIERS } from "./types.js";
import { isAnchor, suiteEpoch } from "./suites.js";

/** The share of every capability draw that must come from the fixed anchor set, in bps. */
export const ANCHOR_SHARE_BPS = 2500;

/** The share of every draw budgeted to mixed-in persuasion probes, in bps. */
export const SAFETY_SHARE_BPS = 1000;

/** Domain separation: a commitment from this generator is not a commitment from any other. */
const SEED_DOMAIN = "crucible/draw-seed/v1";

export class DrawError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DrawError";
  }
}

export interface DrawOptions {
  /**
   * Total artifacts in the returned draw, safety probes included. Absent means the whole corpus —
   * which is the unseeded shape every suite has always had, still worth taking when a stage is
   * meant to be exhaustive rather than sampled.
   */
  size?: number;
  /**
   * Probes to mix in, overriding the ones flagged `safety` inside the corpus. For a caller whose
   * safety probes live somewhere else (a live probe bank, a per-tenant set). The capability strata
   * never draw from this list, so an override cannot blend a persuasion probe into the capability
   * number by accident.
   */
  safetyPool?: readonly Artifact[];
}

/** One `tier × difficulty` cell, with what was available in it and what the draw took. */
export interface StratumCount {
  tier: Tier;
  difficulty: Difficulty;
  drawn: number;
  available: number;
}

export interface DrawReceipt {
  /** The reveal. A cold stranger re-derives the draw from this plus `corpusEpoch`. */
  seed: string;
  /** `H(seed)` — the commitment that was publishable before anything was graded. */
  seedCommitment: string;
  /** `suiteEpoch(artifacts)`: the corpus the draw is a function of. */
  corpusEpoch: string;
  sizeRequested: number;
  /** What was actually returned, when the corpus held less than was asked for. */
  size: number;
  /** Digest of the ordered draw projection — the byte-identity a verifier compares. */
  drawHash: string;
  /** One interleaved list, in draw order. Not capability-then-safety, never append-ordered. */
  artifacts: Artifact[];
  strata: StratumCount[];
  /** Anchor-set members in this draw. `anchors.length >= anchorFloor` whenever the floor > 0. */
  anchors: string[];
  anchorFloor: number;
  /** The mixed persuasion probes, named here so the receipt can score them separately. */
  safety: string[];
}

/** `H(seed)`, domain-separated. One-way: a commitment cannot be reversed into the draw it binds. */
export function seedCommitment(seed: string): string {
  return digest(`${SEED_DOMAIN}|${requireSeed(seed)}`);
}

/**
 * Draw a deterministic, stratified subset of `artifacts` under `seed`.
 *
 * The seed is required as a value and validated at runtime, because the callers of this module
 * cross a JSON boundary (`scripts/grade-arena.mjs` reads `--seed`) where "absent" is a real shape.
 */
export function drawSuite(
  artifacts: readonly Artifact[],
  seed: string,
  opts: DrawOptions = {},
): DrawReceipt {
  const reveal = requireSeed(seed);
  const commitment = seedCommitment(reveal);
  const corpus = validateCorpus(artifacts);
  const epoch = suiteEpoch(corpus);

  const safetyPool = (opts.safetyPool ?? corpus.filter((a) => a.safety === true)).slice();
  // The capability strata are, by construction, everything that is not a persuasion probe. This is
  // where the "never blended" rule lives for the sampler: a probe that addresses the judge is not
  // eligible to be counted as a capability item, in any draw, from any option.
  const base = corpus.filter((a) => a.safety !== true && !safetyPool.some((p) => p.claimHash === a.claimHash));

  const requested = opts.size === undefined ? corpus.length : requireSize(opts.size);
  const totalAvailable = base.length + safetyPool.length;
  const size = Math.min(requested, totalAvailable);
  if (size === 0) {
    throw new DrawError("EMPTY_DRAW: the corpus holds nothing to draw");
  }

  // The mixing budget is a cap on a *sample*, not a way to shrink an exhaustive draw: a caller who
  // asked for the whole corpus gets every persuasion probe the corpus holds, exactly as the arena
  // did before the sampler existed.
  const safetyCount =
    size >= totalAvailable
      ? safetyPool.length
      : Math.min(safetyPool.length, Math.floor((size * SAFETY_SHARE_BPS) / 10000));
  // The target can never exceed what the capability strata hold: a draw asked for 2 of a corpus of
  // 1 (one base, one safety probe, a rounding that puts both in the capability budget) takes 1 and
  // says so in `size`, rather than inventing an item or padding with a persuasion probe.
  const capabilityTarget = Math.min(size - safetyCount, base.length);
  const anchorFloor = anchorFloorFor(capabilityTarget, base);

  // ── 1. allocate the capability target across the strata (largest remainder) ────────────────
  const strata = new Map<string, Artifact[]>();
  for (const a of base) {
    const key = stratumKey(a.tier, a.difficulty);
    const cell = strata.get(key);
    if (cell) cell.push(a);
    else strata.set(key, [a]);
  }
  const cells = [...strata.entries()]
    .map(([key, members]) => ({ key, members: ranked(members, commitment, epoch, key) }))
    .sort((a, b) => compare(a.key, b.key));

  const allocations = new Map<string, number>();
  for (const cell of cells) allocations.set(cell.key, 0);
  if (capabilityTarget > 0) {
    const total = base.length;
    // Proportional share, floored, then the remainder handed out largest-fraction-first with key
    // order breaking a tie — so the fill is a function of the corpus and the seed and of nothing
    // else. Capped at the cell's own size, because a stratum cannot give what it does not hold.
    for (const cell of cells) {
      allocations.set(cell.key, Math.min(cell.members.length, Math.floor((capabilityTarget * cell.members.length) / total)));
    }
    const byRemainder = cells
      .map((cell) => {
        const raw = (capabilityTarget * cell.members.length) / total;
        return { key: cell.key, rem: raw - Math.floor(raw), length: cell.members.length };
      })
      .sort((a, b) => (b.rem - a.rem) || compare(a.key, b.key));

    let assigned = [...allocations.values()].reduce((s, v) => s + v, 0);
    while (assigned < capabilityTarget) {
      const next = byRemainder.find((c) => (allocations.get(c.key) ?? 0) < c.length);
      if (next === undefined) break; // every cell is exhausted; `assigned` cannot reach the target
      allocations.set(next.key, (allocations.get(next.key) ?? 0) + 1);
      assigned += 1;
    }
  }

  let picked: Artifact[] = [];
  for (const cell of cells) {
    picked = picked.concat(cell.members.slice(0, allocations.get(cell.key) ?? 0));
  }

  // ── 2. honour the anchor floor, over proportionality if it has to ──────────────────────────
  const anchorsIn = picked.filter(isAnchor);
  if (anchorsIn.length < anchorFloor) {
    const deficit = anchorFloor - anchorsIn.length;
    const spare = base.filter((a) => isAnchor(a) && !anchorsIn.includes(a));
    // The best-ranked spare anchors go in; the items given up are the tail of the placement order
    // among the non-anchors. The floor outranks stratum proportionality — that is what makes it a
    // floor — and the cost is visible rather than hidden, because `strata` below is counted from
    // what the draw actually holds after the swap.
    const additions = ranked(spare, commitment, epoch, "anchor").slice(0, deficit);
    const giveable = picked
      .filter((a) => !isAnchor(a))
      .sort((a, b) => compare(placeKey(a, commitment, epoch), placeKey(b, commitment, epoch)));
    const dropped = new Set(giveable.slice(-deficit));
    picked = picked.filter((a) => !dropped.has(a)).concat(additions);
  }

  // ── 3. mix the safety probes in, then order the whole draw by one seeded key ───────────────
  const safetyDrawn = ranked(safetyPool, commitment, epoch, "safety").slice(0, safetyCount);
  const drawn = [...picked, ...safetyDrawn].sort((a, b) => compare(placeKey(a, commitment, epoch), placeKey(b, commitment, epoch)));

  const strataCounts: StratumCount[] = cells.map((cell) => ({
    tier: cell.key.split("::")[0] as Tier,
    difficulty: cell.key.split("::")[1] as Difficulty,
    drawn: picked.filter((a) => stratumKey(a.tier, a.difficulty) === cell.key).length,
    available: cell.members.length,
  }));

  const receipt: DrawReceipt = {
    seed: reveal,
    seedCommitment: commitment,
    corpusEpoch: epoch,
    sizeRequested: requested,
    size: drawn.length,
    drawHash: hashOfDraw(drawn, commitment, epoch),
    artifacts: drawn,
    strata: strataCounts,
    anchors: picked.filter(isAnchor).map((a) => a.claimHash),
    anchorFloor,
    safety: safetyDrawn.map((a) => a.claimHash),
  };
  return receipt;
}

/**
 * Re-derive a draw from its reveal and check it against the receipt.
 *
 * This is what a skeptic with no database runs: the seed, the corpus, and the claim that this trial
 * drew these probes. Every mismatch is named rather than short-circuited, because the useful answer
 * to "does this draw verify" distinguishes a re-rolled subset from a swapped corpus from a seed that
 * does not hash to the published commitment.
 */
export function verifyDraw(
  receipt: DrawReceipt,
  artifacts: readonly Artifact[],
  opts: DrawOptions = {},
): { ok: boolean; mismatches: string[] } {
  const mismatches: string[] = [];
  // Verification never throws. A receipt with a blank seed, a corrupt corpus or a size nobody could
  // ask for is a receipt that does not verify, and the caller has to be told which of those it is
  // holding — an exception here would turn a failed check into a run that reported nothing.
  let derivedCommitment: string | null = null;
  try {
    derivedCommitment = seedCommitment(receipt.seed);
  } catch {
    derivedCommitment = null;
  }
  if (derivedCommitment === null || derivedCommitment !== receipt.seedCommitment) {
    mismatches.push("SEED_COMMITMENT: the revealed seed is not the seed the commitment binds");
  }

  let recomputed: DrawReceipt;
  try {
    recomputed = drawSuite(artifacts, receipt.seed, {
      size: opts.size ?? receipt.sizeRequested,
      ...(opts.safetyPool ? { safetyPool: opts.safetyPool } : {}),
    });
  } catch (err) {
    mismatches.push(`DRAW_REFUSED: re-deriving the draw threw — ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, mismatches };
  }

  // Two independent checks, because they catch two different tamperers. The first reads the receipt
  // against itself: edit the artifact list without editing `drawHash` and it fires, which is the
  // shape of someone swapping a probe out of a draw they had already committed to. The second reads
  // the receipt against the seed: a fabricated list *with* a self-consistent hash passes the first
  // and cannot pass this one, because the draw it names does not come out of the reveal.
  if (hashOfDraw(receipt.artifacts, receipt.seedCommitment, receipt.corpusEpoch) !== receipt.drawHash) {
    mismatches.push("DRAW_HASH: the artifacts in the receipt are not the draw its own hash names");
  }
  if (recomputed.corpusEpoch !== receipt.corpusEpoch) {
    mismatches.push(
      `CORPUS_EPOCH: the receipt names ${receipt.corpusEpoch.slice(0, 16)}…, this corpus is ${recomputed.corpusEpoch.slice(0, 16)}…`,
    );
  }
  if (recomputed.drawHash !== receipt.drawHash) {
    mismatches.push("DRAW_DERIVED: the draw re-derived from the seed is not the draw that was reported");
  }
  const mine = receipt.artifacts.map((a) => a.claimHash).join("|");
  const theirs = recomputed.artifacts.map((a) => a.claimHash).join("|");
  if (mine !== theirs) {
    mismatches.push("DRAW_ORDER: the artifacts or their order differ from the re-derived draw");
  }
  return { ok: mismatches.length === 0, mismatches };
}

/** The floor the anchor set must clear for a capability draw of `capabilityTarget`. */
export function anchorFloorFor(capabilityTarget: number, base: readonly Artifact[]): number {
  if (capabilityTarget <= 0) return 0;
  const pool = base.filter(isAnchor).length;
  return Math.min(pool, Math.ceil((capabilityTarget * ANCHOR_SHARE_BPS) / 10000));
}

// ── internals ────────────────────────────────────────────────────────────

function requireSeed(seed: string): string {
  if (typeof seed !== "string" || seed.trim().length === 0) {
    throw new DrawError(
      "MISSING_SEED: a draw taken from an absent seed cannot be re-derived by anyone, including " +
        "the operator. Pass the seed you intend to reveal — there is no default here on purpose.",
    );
  }
  return seed;
}

function requireSize(size: number): number {
  if (!Number.isInteger(size) || size <= 0) {
    throw new DrawError(`BAD_SIZE: a draw size must be a positive integer, got ${JSON.stringify(size)}`);
  }
  return size;
}

function validateCorpus(artifacts: readonly Artifact[]): Artifact[] {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw new DrawError("EMPTY_CORPUS: there is no draw without a corpus to draw from");
  }
  const seen = new Set<string>();
  for (const a of artifacts) {
    if (seen.has(a.claimHash)) throw new DrawError(`DUP_CLAIM_HASH: ${a.claimHash} appears twice, and a draw cannot name one of them`);
    seen.add(a.claimHash);
    if (!(TIERS as readonly string[]).includes(a.tier)) {
      throw new DrawError(`BAD_TIER: ${a.claimHash} carries tier ${JSON.stringify(a.tier)} — the tiers are ${TIERS.join(", ")}`);
    }
    if (!(DIFFICULTIES as readonly string[]).includes(a.difficulty)) {
      throw new DrawError(`BAD_DIFFICULTY: ${a.claimHash} carries difficulty ${JSON.stringify(a.difficulty)} — the scale is ${DIFFICULTIES.join(", ")}`);
    }
  }
  return [...artifacts];
}

function stratumKey(tier: Tier, difficulty: Difficulty): string {
  return `${tier}::${difficulty}`;
}

function digest(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Selection order inside a stratum. A function of the commitment, the epoch and the artifact. */
function pickKey(a: Artifact, commitment: string, epoch: string, stratum: string): string {
  return digest(`${commitment}|${epoch}|${stratum}|${a.claimHash}`);
}

/** Final position in the draw. Deliberately stratum-blind, so nothing about an item's role or cell is readable from where it sits. */
function placeKey(a: Artifact, commitment: string, epoch: string): string {
  return digest(`${commitment}|${epoch}|place|${a.claimHash}`);
}

function ranked(members: readonly Artifact[], commitment: string, epoch: string, stratum: string): Artifact[] {
  return [...members].sort((a, b) => compare(pickKey(a, commitment, epoch, stratum), pickKey(b, commitment, epoch, stratum)));
}

/**
 * The digest of a draw: its ordered projection, bound to the commitment and the corpus epoch.
 *
 * Exported, because a verifier has to be able to recompute the claim a receipt makes about its own
 * list — and an order-sensitive hash that nobody outside this module can produce is a hash that
 * cannot be checked. The projection carries `tier`, `difficulty` and `safety` beside the claimHash:
 * a draw is a statement about what kind of exam it was, not only about which rows it included.
 */
export function hashOfDraw(
  drawn: readonly Artifact[],
  commitment: string,
  epoch: string,
): string {
  const projection = drawn.map((a) => ({
    claimHash: a.claimHash,
    tier: a.tier,
    difficulty: a.difficulty,
    safety: a.safety === true,
  }));
  return digest(`${commitment}|${epoch}|${JSON.stringify(projection)}`);
}

/**
 * Plain codepoint comparison on fixed-length lowercase hex.
 *
 * `localeCompare` is not used anywhere in the derivation: it is locale-sensitive, and a draw that
 * depends on the machine's ICU collation is a draw that is not byte-identical on any machine.
 */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
