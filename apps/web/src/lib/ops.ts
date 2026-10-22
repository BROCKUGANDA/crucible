/**
 * The assay: what this site actually measured about itself, and what it could not see.
 *
 * `/health`, `/ready` and `/snapshot` already publish all of this — the index's reach, the
 * indexer's last error, the dead letters it survived, which dependency breakers are tripped,
 * the trial counts and the protocol's books. None of it was ever displayed, so an operator
 * could only read it out of a curl session while a visitor saw none of it.
 *
 * Everything in this file is therefore a mapping from a live payload to a rendered string,
 * and it is kept pure and separate from the page for the reason the rest of the app keeps
 * its derivations pure: a claim that cannot be asserted against a fixture is a claim that
 * will silently report empty.
 *
 * ── the one rule ───────────────────────────────────────────────────────────────────────
 * **Unavailable renders as unknown, never as zero.** `num(0)` is `"0"` only when a payload
 * actually said 0. A field that is absent, null, or whose endpoint never answered is the em
 * dash. The two are different sentences — "the queue is empty" is a fact about the process,
 * "the queue was not read" is a fact about this page — and printing the first when the second
 * is true is the fabricated measurement this repository was hunted for.
 */

import type { ApiSnapshot } from "@crucible/indexer";
import { formatEth, formatDuration, statusMeta, type Tone } from "./forge";

/** The site's existing "no measurement" glyph, shared with `formatEth` and `formatDuration`. */
export const UNKNOWN = "—";

/** A number that arrived is printed; a number that did not is not guessed at. */
export function num(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : UNKNOWN;
}

/** Any string/number that arrived is printed verbatim; anything else is the em dash. */
export function text(value: string | number | null | undefined): string {
  if (typeof value === "number") return num(value);
  return typeof value === "string" && value.length > 0 ? value : UNKNOWN;
}

/** `POST`-free operator surface: the dead-letter summary inside `/health`. */
export interface DlqPayload {
  size?: number | null;
  lastAt?: number | null;
  lastKind?: string | null;
  /** `/health` publishes this as null on purpose — a viem error carries the RPC URL. */
  lastDetail?: string | null;
}

export interface BreakerPayload {
  state?: string | null;
  failures?: number | null;
  openedAt?: number | null;
  lastFailure?: number | null;
  consecutiveSuccesses?: number | null;
  probesUsed?: number | null;
  /** ms until a probe is admitted; null unless the breaker is time-gated */
  retryAfterMs?: number | null;
}

export interface HealthPayload {
  ok?: boolean | null;
  trials?: number | null;
  indexedTo?: number | null;
  head?: number | null;
  syncError?: string | null;
  dlq?: DlqPayload | null;
  breakers?: Record<string, BreakerPayload> | null;
}

export interface ReadyPayload {
  ready?: boolean | null;
  reason?: string | null;
  head?: number | null;
  indexedTo?: number | null;
  lag?: number | null;
  maxLag?: number | null;
  syncError?: string | null;
  trials?: number | null;
}

export interface BreakerView {
  /** the breaker's own name, which is the key the API keyed it under */
  name: string;
  state: string;
  tone: Tone;
  failures: string;
  /** a sentence, because "30s" beside a breaker is not obviously a wait */
  probe: string;
}

export interface CountView {
  key: string;
  label: string;
  value: string;
  tone: Tone;
}

export interface OpsView {
  /** Whether each endpoint answered at all — every cell below depends on it. */
  healthRead: boolean;
  readyRead: boolean;

  indexedTo: string;
  head: string;
  lag: string;
  /** how far behind the gate allows, from `/ready`'s own `maxLag` */
  tolerance: string;
  /** the freshness sentence, worded to what was actually measured */
  reach: string;
  reachTone: Tone;
  /** which endpoint the lag came from, so the page can attribute the number it prints */
  lagSource: string;

  /** the API's own verdict about itself, in its word rather than this page's */
  apiVerdict: string;
  apiVerdictTone: Tone;

  syncError: string;
  syncErrorTone: Tone;

  readyVerdict: string;
  readyTone: Tone;
  readyReason: string;

  dlqSize: string;
  dlqLastKind: string;
  dlqLastAge: string;

  breakers: BreakerView[];
  breakersNote: string;
  breakersNoteTone: Tone;

  counts: CountView[];
  /** `counts.all`, kept beside the per-status rows so a reader can add them up */
  total: string;

  volume: string;
  fees: string;
  paidOut: string;
  paidSettlements: string;
  feeRate: string;
}

/** Breaker states are the vocabulary in `packages/smith-sdk/src/patterns.ts`. */
const BREAKER_TONE: Record<string, Tone> = {
  closed: "quench",
  "half-open": "gold",
  open: "sear",
};

/** A state this bundle has not heard of is not `closed`, and not `open` either. */
function breakerTone(state: string | null | undefined): Tone {
  if (typeof state !== "string") return "faint";
  return BREAKER_TONE[state] ?? "faint";
}

const STATUS_ORDER = ["open", "assigned", "judging", "challenged", "settled"] as const;

/**
 * The block lag, and where it came from.
 *
 * `/ready` computes the lag the load balancer acts on, so that number is used when it exists:
 * re-deriving it in the browser would let the page disagree with the gate that decides whether
 * traffic reaches the instance it just described. When only `/health` answered, the two block
 * numbers it publishes are subtracted here instead — the same arithmetic, but the page says
 * which endpoint it got it from rather than presenting it as the gate's own reading.
 */
function deriveLag(
  ready: ReadyPayload | null,
  health: HealthPayload | null,
): { lag: number | null; source: string } {
  if (ready && typeof ready.lag === "number") return { lag: ready.lag, source: "reported by /ready" };
  if (
    health &&
    typeof health.head === "number" &&
    typeof health.indexedTo === "number" &&
    health.head !== null &&
    health.indexedTo !== null
  ) {
    // `/health` publishes null for "never read", so the guards above are load-bearing:
    // subtracting across a null is where a zero would sneak in.
    return { lag: Math.max(0, health.head - health.indexedTo), source: "derived from /health" };
  }
  return { lag: null, source: "not reported" };
}

/**
 * Map the three live payloads to the strings the page prints.
 *
 * `snapshot` is the same object the rest of the site renders from, so the trial counts and the
 * books here cannot disagree with the trial list or the arena HUD beside them.
 */
export function deriveOps(input: {
  health: HealthPayload | null;
  ready: ReadyPayload | null;
  snapshot: ApiSnapshot | null;
  serverNowMs: number | null;
}): OpsView {
  const { health, ready, snapshot } = input;
  const healthRead = health !== null;
  const readyRead = ready !== null;

  const indexedTo = health?.indexedTo ?? ready?.indexedTo ?? null;
  const head = health?.head ?? ready?.head ?? null;
  const { lag, source } = deriveLag(ready, health);

  const tolerance = ready?.maxLag ?? null;

  // The freshness sentence is built from what was measured, and says so when it was not.
  // The wording is deliberately not a dashboard's: a visitor who has to know what a cursor is
  // has been handed an engineering report instead of an answer.
  let reach: string;
  let reachTone: Tone;
  if (lag === null) {
    reach = "not read — neither the head of the chain nor how far this forge has listened was published";
    reachTone = "faint";
  } else if (tolerance === null) {
    reach = `${lag} block${lag === 1 ? "" : "s"} behind the head, with no tolerance published`;
    reachTone = lag > 0 ? "gold" : "dim";
  } else if (lag <= tolerance) {
    reach = `${lag} block${lag === 1 ? "" : "s"} behind the head, within the ${tolerance} this forge will serve at`;
    reachTone = "quench";
  } else {
    reach = `${lag} blocks behind the head — past the ${tolerance} it will serve at, so what is on screen is not the whole read`;
    reachTone = "sear";
  }

  const syncError = health?.syncError ?? ready?.syncError ?? null;
  // An explicit null from an endpoint that answered IS a measurement: the indexer reported no
  // failed tick. Only a page that never reached the endpoint gets to say unknown.
  const syncSeen = healthRead || readyRead;

  const dlq = health?.dlq ?? null;
  const dlqLastAt = dlq?.lastAt ?? null;
  const dlqLastKind = dlq?.lastKind ?? null;
  const dlqSize = dlq?.size ?? null;

  // Age against the server's own clock, which is the only clock `dlq.lastAt` was written with.
  const dlqAge =
    typeof dlqLastAt === "number" && typeof input.serverNowMs === "number"
      ? `${formatDuration((input.serverNowMs - dlqLastAt) / 1000)} ago`
      : UNKNOWN;

  const breakers = health?.breakers ?? null;
  const breakerViews: BreakerView[] = Object.entries(breakers ?? {}).map(([name, b]) => {
    // A breaker that answers with an empty `state` is not in state `""`, and it is not in a state
    // this page can name. `text` is what makes that distinction hold in the rendered cell too.
    const state = typeof b?.state === "string" && b.state.length > 0 ? b.state : null;
    const retryAfterMs = b?.retryAfterMs;
    return {
      name,
      state: text(state),
      tone: breakerTone(state),
      // Counted inside the breaker's own sliding window, so the number has a denominator the
      // reader can see beside it rather than a bare figure.
      failures:
        typeof b?.failures === "number"
          ? `${b.failures} failed call${b.failures === 1 ? "" : "s"}`
          : `failed calls ${UNKNOWN}`,
      // `retryAfterMs` is null for a breaker that is not currently time-gated, which is not
      // the same as a tripped breaker whose wait is unknown.
      probe:
        state === "open"
          ? typeof retryAfterMs === "number"
            ? `one test call in ${formatDuration(Math.ceil(retryAfterMs / 1000))}`
            : `wait to test ${UNKNOWN}`
          : "not holding anything back",
    };
  });

  const counts = snapshot?.counts ?? null;
  const countValue = (key: string): string =>
    num((counts as Record<string, number> | null | undefined)?.[key]);
  const countViews: CountView[] = [];
  // The five states this site knows about always get a row, whether or not the payload carried
  // one. A report that loses its "Settled" line because an older API did not send the key is a
  // report with a hole in it that reads as a clean sheet — so the line stays and its value is
  // the em dash.
  for (const key of STATUS_ORDER) {
    countViews.push({ key, label: statusMeta(key).label, value: countValue(key), tone: statusMeta(key).tone });
  }
  // A status the chain has and this bundle does not is printed too, rather than dropped from a
  // total the reader cannot add up. Its label is its own name: inventing copy for a state nobody
  // has described would be this page speaking for an API it did not read.
  if (counts) {
    for (const key of Object.keys(counts)) {
      if (key === "all" || (STATUS_ORDER as readonly string[]).includes(key)) continue;
      const meta = statusMeta(key);
      countViews.push({ key, label: meta.label, value: num((counts as Record<string, number>)[key]), tone: meta.tone });
    }
  }

  const economics = snapshot?.economics ?? null;

  return {
    healthRead,
    readyRead,

    indexedTo: num(indexedTo),
    head: num(head),
    lag: num(lag),
    tolerance: num(tolerance),
    reach,
    reachTone,
    lagSource: source,

    apiVerdict: !healthRead
      ? UNKNOWN
      : health?.ok === true
        ? "healthy"
        : health?.ok === false
          ? "stalled"
          : UNKNOWN,
    // `ok` is the API's conclusion, and a page that coloured a missing `ok` green would be
    // grading its own silence as a pass.
    apiVerdictTone: !healthRead || typeof health?.ok !== "boolean" ? "faint" : health.ok ? "quench" : "sear",

    syncError: !syncSeen ? UNKNOWN : (syncError ?? "no failed read reported"),
    syncErrorTone: !syncSeen ? "faint" : syncError ? "sear" : "quench",

    readyVerdict: !readyRead
      ? UNKNOWN
      : ready?.ready === true
        ? "ready"
        : ready?.ready === false
          ? "not ready"
          : UNKNOWN,
    readyTone: !readyRead ? "faint" : ready?.ready === true ? "quench" : "sear",
    readyReason: !readyRead
      ? UNKNOWN
      : typeof ready?.reason === "string" && ready.reason.length > 0
        ? ready.reason
        : ready?.ready === true
          ? "no reason given — every gate passed"
          : "not ready, and no reason was published",

    dlqSize: num(dlqSize),
    // A queue that says it holds nothing has no last entry; a queue that holds something but
    // cannot name it is a contradiction, and gets the em dash rather than a reassuring word.
    dlqLastKind: text(dlqLastKind ?? (dlqSize === 0 ? "nothing in it" : null)),
    dlqLastAge: dlqSize === 0 ? UNKNOWN : dlqAge,

    breakers: breakerViews,
    breakersNote: !healthRead
      ? "not read — which lines are tripped comes from /health"
      : breakers === null || breakers === undefined
        ? "/health published no trip-wire states"
        : breakerViews.length === 0
          ? "this forge wired no trip-wires at all, which is not the same as every dependency being clear"
          : "a tripped line is why the reading above stops moving",
    breakersNoteTone: !healthRead || breakers === null ? "faint" : "dim",

    counts: countViews,
    total: num(counts?.all ?? null),

    volume: formatEth(economics?.volumeEth ?? null),
    fees: formatEth(economics?.feesEth ?? null),
    paidOut: formatEth(economics?.paidOutEth ?? null),
    paidSettlements: num(economics?.paidSettlements ?? null),
    // The rate is a chain read, and the API publishes null when that read failed. Zero here
    // would say the protocol charges nothing, on the authority of a page that does not know.
    feeRate: economics?.feeBps === null || economics?.feeBps === undefined ? UNKNOWN : `${economics.feeBps} bps`,
  };
}
