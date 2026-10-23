import { describe, expect, it } from "vitest";
import type { ApiSnapshot } from "@crucible/indexer";
import {
  UNKNOWN,
  deriveOps,
  formatFeeRate,
  num,
  text,
  type HealthPayload,
  type ReadyPayload,
} from "@/lib/ops";

/**
 * The assay's mapping from a live API payload to a rendered string.
 *
 * `/health`, `/ready` and `/snapshot` already publish every number on that page and nothing read
 * them, which is how a shipped feature stays invisible. The risk that replaces is the one this
 * project has been hunted for six times: a cell that prints a plausible figure because the code
 * had to print *something*. So the assertion that matters is not "does it show 12 blocks" but
 * "does it show 12 blocks only when the API said 12".
 *
 * Every `UNKNOWN` below is the em dash; every `"0"` is a zero the payload actually published.
 * The tests are written in pairs so the two can never be confused by a future edit.
 */

const SERVER_NOW = 1_800_000_000_000;

function snapshot(over: Partial<ApiSnapshot>): ApiSnapshot {
  return {
    now: SERVER_NOW,
    trials: [],
    agents: [],
    hall: [],
    counts: { all: 0, open: 0, assigned: 0, judging: 0, challenged: 0, settled: 0 },
    economics: {
      paidOutEth: "0",
      feesEth: "0",
      volumeEth: "0",
      paidSettlements: 0,
      feeBps: 500,
    },
    ...over,
  } as ApiSnapshot;
}

function ops(over: {
  health?: HealthPayload | null;
  ready?: ReadyPayload | null;
  snapshot?: ApiSnapshot | null;
  serverNowMs?: number | null;
}) {
  return deriveOps({
    health: over.health ?? null,
    ready: over.ready ?? null,
    snapshot: over.snapshot ?? null,
    // `?? SERVER_NOW` here would silently turn a test's explicit "no clock" into a clock, which
    // is the very defect the page is written against. Presence is checked, not truthiness.
    serverNowMs: "serverNowMs" in over ? (over.serverNowMs ?? null) : SERVER_NOW,
  });
}

describe("num — the zero/unknown line", () => {
  it("prints a zero the payload actually published", () => {
    expect(num(0)).toBe("0");
    expect(num(-0)).toBe("0");
  });

  it("prints an em dash for a number that never arrived", () => {
    expect(num(null)).toBe(UNKNOWN);
    expect(num(undefined)).toBe(UNKNOWN);
    expect(num(NaN)).toBe(UNKNOWN);
    expect(num(Infinity)).toBe(UNKNOWN);
  });

  it("never renders an absent number as the character 0", () => {
    // The exact defect: `String(v ?? 0)` and `String(v)` look the same in review and disagree
    // on screen for every outage.
    expect(num(null)).not.toBe("0");
    expect(num(undefined)).not.toBe("0");
  });

  it("keeps a text field's absence distinct from its content", () => {
    expect(text("scribe.sync")).toBe("scribe.sync");
    expect(text(0)).toBe("0");
    expect(text(null)).toBe(UNKNOWN);
    expect(text("")).toBe(UNKNOWN);
  });
});

describe("index reach", () => {
  it("reports the lag the readiness gate itself computed, and says where it came from", () => {
    const view = ops({ ready: { ready: true, reason: null, head: 100, indexedTo: 98, lag: 2, maxLag: 5 } });
    expect(view.lag).toBe("2");
    expect(view.tolerance).toBe("5");
    expect(view.lagSource).toBe("reported by /ready");
    expect(view.reach).toContain("within the 5 this forge will serve at");
    expect(view.reachTone).toBe("quench");
  });

  it("derives the lag from /health only when /ready did not answer, and admits it did", () => {
    const view = ops({ health: { ok: true, indexedTo: 40, head: 47 } });
    expect(view.lag).toBe("7");
    // Attributed, because a page that recomputes the gate's own number and prints it as the
    // gate's is a page that can silently disagree with what is routing traffic.
    expect(view.lagSource).toBe("derived from /health");
    expect(view.tolerance).toBe(UNKNOWN);
    expect(view.reach).toContain("with no tolerance published");
    expect(view.reachTone).toBe("gold");
  });

  it("calls an unmeasured lag unmeasured instead of zero blocks behind", () => {
    // `/health` publishes `head: null` until the chain head has been read once. A cold instance
    // is behind by an unknown amount, not by nothing.
    const view = ops({ health: { ok: true, indexedTo: 0, head: null } });
    expect(view.lag).toBe(UNKNOWN);
    expect(view.head).toBe(UNKNOWN);
    expect(view.indexedTo).toBe("0");
    expect(view.reach).toContain("not read");
    expect(view.reachTone).toBe("faint");
  });

  it("reads a cursor at block zero as zero, not as absent", () => {
    const view = ops({ health: { ok: true, indexedTo: 0, head: 0 }, ready: { ready: true, lag: 0, maxLag: 5 } });
    expect(view.indexedTo).toBe("0");
    expect(view.lag).toBe("0");
    expect(view.reach).toContain("within the 5");
  });

  it("names it as incomplete serving when the lag is past the tolerance", () => {
    const view = ops({ ready: { ready: false, reason: "too far behind", head: 100, indexedTo: 10, lag: 90, maxLag: 5 } });
    expect(view.reach).toContain("past the 5 it will serve at");
    expect(view.reachTone).toBe("sear");
    expect(view.readyVerdict).toBe("not ready");
    expect(view.readyTone).toBe("sear");
    expect(view.readyReason).toBe("too far behind");
  });

  it("quotes the API's own health verdict without grading its silence", () => {
    expect(ops({ health: { ok: true } }).apiVerdict).toBe("healthy");
    expect(ops({ health: { ok: false } }).apiVerdict).toBe("stalled");
    expect(ops({ health: { ok: false } }).apiVerdictTone).toBe("sear");
    // `/health` answered but published no `ok`: not a pass, and not green.
    const blank = ops({ health: {} });
    expect(blank.apiVerdict).toBe(UNKNOWN);
    expect(blank.apiVerdictTone).toBe("faint");
  });
});

describe("sync errors and dead letters", () => {
  it("treats an explicit null sync error as a measurement once the endpoint answered", () => {
    const view = ops({ health: { ok: true, syncError: null } });
    expect(view.syncError).toBe("no failed read reported");
    expect(view.syncErrorTone).toBe("quench");
  });

  it("publishes the indexer's own sentence when it failed", () => {
    const view = ops({ health: { ok: false, syncError: "unavailable: node is pruning this range" } });
    expect(view.syncError).toBe("unavailable: node is pruning this range");
    expect(view.syncErrorTone).toBe("sear");
  });

  it("says unknown about the sync error when nothing answered", () => {
    const view = ops({});
    expect(view.syncError).toBe(UNKNOWN);
    expect(view.syncErrorTone).toBe("faint");
    expect(view.healthRead).toBe(false);
    expect(view.readyRead).toBe(false);
  });

  it("reads an empty dead-letter queue as empty, which is a fact about the process", () => {
    const view = ops({ health: { dlq: { size: 0, lastAt: null, lastKind: null, lastDetail: null } } });
    expect(view.dlqSize).toBe("0");
    expect(view.dlqLastKind).toBe("nothing in it");
  });

  it("renders a queue that was never read as unknown, which is a fact about this page", () => {
    expect(ops({}).dlqSize).toBe(UNKNOWN);
    expect(ops({}).dlqLastKind).toBe(UNKNOWN);
    expect(ops({ health: {} }).dlqSize).toBe(UNKNOWN);
  });

  it("ages the last failure against the server's clock, the only clock that wrote it", () => {
    const view = ops({
      health: { dlq: { size: 3, lastAt: SERVER_NOW - 90_000, lastKind: "scribe.sync", lastDetail: null } },
      serverNowMs: SERVER_NOW,
    });
    expect(view.dlqSize).toBe("3");
    expect(view.dlqLastKind).toBe("scribe.sync");
    expect(view.dlqLastAge).toBe("1m 30s ago");
  });

  it("refuses to age a failure when the clock it would be measured against is missing", () => {
    const view = ops({
      health: { dlq: { size: 3, lastAt: SERVER_NOW - 90_000, lastKind: "scribe.sync" } },
      serverNowMs: null,
    });
    expect(view.dlqLastAge).toBe(UNKNOWN);
  });

  it("does not turn a queue with entries but no named kind into a reassuring word", () => {
    const view = ops({ health: { dlq: { size: 2, lastAt: null, lastKind: null } } });
    expect(view.dlqSize).toBe("2");
    expect(view.dlqLastKind).toBe(UNKNOWN);
  });
});

describe("circuit breakers", () => {
  it("names each breaker by the key the API keyed it under", () => {
    const view = ops({
      health: { breakers: { "scribe.rpc": { state: "closed", failures: 0, retryAfterMs: null } } },
    });
    expect(view.breakers).toHaveLength(1);
    expect(view.breakers[0]!.name).toBe("scribe.rpc");
    expect(view.breakers[0]!.state).toBe("closed");
    expect(view.breakers[0]!.tone).toBe("quench");
    expect(view.breakers[0]!.failures).toBe("0 failed calls");
    expect(view.breakers[0]!.probe).toBe("not holding anything back");
  });

  it("follows the breaker's own state vocabulary for tone", () => {
    const tone = (state: string) =>
      ops({ health: { breakers: { b: { state } } } }).breakers[0]!.tone;
    expect(tone("closed")).toBe("quench");
    expect(tone("half-open")).toBe("gold");
    expect(tone("open")).toBe("sear");
    // A state this bundle has not heard of is not "closed". The demo can add one; the page
    // prints what it does not know as unknown rather than guessing the friendly reading.
    expect(tone("disarmed")).toBe("faint");
    expect(tone("disarmed")).not.toBe("quench");
  });

  it("reports the wait a tripped breaker is imposing", () => {
    const view = ops({ health: { breakers: { "scribe.rpc": { state: "open", failures: 4, retryAfterMs: 30_000 } } } });
    expect(view.breakers[0]!.failures).toBe("4 failed calls");
    expect(view.breakers[0]!.probe).toBe("one test call in 30s");
  });

  it("says when a breaker's failure count was not published", () => {
    const view = ops({ health: { breakers: { b: { state: "half-open" } } } });
    expect(view.breakers[0]!.failures).toBe("failed calls " + UNKNOWN);
  });

  it("does not read an empty breaker object as every dependency being clear", () => {
    const view = ops({ health: { breakers: {} } });
    expect(view.breakers).toHaveLength(0);
    expect(view.breakersNote).toContain("wired no trip-wires");
    expect(view.breakersNote).not.toMatch(/all clear|healthy|closed/);
  });

  it("distinguishes a missing breaker field from an empty one", () => {
    expect(ops({ health: {} }).breakersNote).toBe("/health published no trip-wire states");
    expect(ops({}).breakersNote).toContain("not read");
  });

  it("reads an empty string as unmeasured rather than as a blank cell", () => {
    // A payload whose `state` or `lastKind` is `""` has said nothing. Printing the empty string
    // faithfully would leave a blank that reads as a measured blank — the same lie as a zero,
    // just quieter.
    const view = ops({
      health: { dlq: { size: 2, lastKind: "" }, breakers: { b: { state: "" } } },
    });
    expect(view.breakers[0]!.state).toBe(UNKNOWN);
    expect(view.breakers[0]!.tone).toBe("faint");
    expect(view.dlqLastKind).toBe(UNKNOWN);
  });
});

describe("trial counts and the books", () => {
  it("counts a settled-zero snapshot as measured zeros, not as unknown", () => {
    const view = ops({ snapshot: snapshot({}) });
    expect(view.total).toBe("0");
    expect(view.counts.map((c) => c.value)).toEqual(["0", "0", "0", "0", "0"]);
  });

  it("maps the payload's counts onto the rows the page prints", () => {
    const view = ops({
      snapshot: snapshot({
        counts: { all: 9, open: 3, assigned: 2, judging: 1, challenged: 0, settled: 3 },
      }),
    });
    expect(view.total).toBe("9");
    const byKey = Object.fromEntries(view.counts.map((c) => [c.key, c.value]));
    expect(byKey).toEqual({ open: "3", assigned: "2", judging: "1", challenged: "0", settled: "3" });
    // `challenged: 0` is the case a fabricated zero would hide behind: it is a real measurement
    // here because the counts object that carried it was actually read.
    expect(byKey.challenged).toBe("0");
  });

  it("keeps the row for a status the payload omitted instead of dropping it", () => {
    const view = ops({
      snapshot: snapshot({ counts: { all: 1, open: 1 } as unknown as ApiSnapshot["counts"] }),
    });
    const byKey = Object.fromEntries(view.counts.map((c) => [c.key, c.value]));
    expect(byKey.open).toBe("1");
    expect(byKey.settled).toBe(UNKNOWN);
  });

  it("prints a status the bundle does not know rather than silently dropping it", () => {
    const view = ops({
      snapshot: snapshot({
        counts: { all: 2, open: 2, arbitrating: 2 } as unknown as ApiSnapshot["counts"],
      }),
    });
    const extra = view.counts.find((c) => c.key === "arbitrating");
    expect(extra?.value).toBe("2");
    // The unknown status keeps its own name; inventing a label for it would be a claim about a
    // state this bundle has no copy of.
    expect(extra?.label).toBe("arbitrating");
  });

  it("renders every count as unknown before the snapshot arrives", () => {
    const view = ops({});
    expect(view.total).toBe(UNKNOWN);
    expect(view.counts.every((c) => c.value === UNKNOWN)).toBe(true);
  });

  it("shows the books in ETH from the payload's own decimal strings", () => {
    const view = ops({
      snapshot: snapshot({
        economics: {
          paidOutEth: "1.4",
          feesEth: "0.07",
          volumeEth: "12.5",
          paidSettlements: 4,
          feeBps: 500,
        },
      }),
    });
    // `formatEth` is this site's existing display rule, trailing zeros trimmed: the assay uses
    // it rather than a second money format of its own.
    expect(view.volume).toBe("12.5 ETH");
    expect(view.fees).toBe("0.07 ETH");
    expect(view.paidOut).toBe("1.4 ETH");
    expect(view.paidSettlements).toBe("4");
    // The plain rate leads and the stored read follows: every other label on this page is written
    // for a reader ("Fees kept", not `feesEth`), so a bare basis-points figure was the one line
    // that asked a judge to do the conversion.
    expect(view.feeRate).toBe("5% · 500 bps");
  });

  describe("formatFeeRate", () => {
    it("states the rate a visitor reads and keeps the chain's unit beside it", () => {
      expect(formatFeeRate(500)).toBe("5% · 500 bps");
      expect(formatFeeRate(5)).toBe("0.05% · 5 bps");
      expect(formatFeeRate(50)).toBe("0.5% · 50 bps");
      expect(formatFeeRate(555)).toBe("5.55% · 555 bps");
      expect(formatFeeRate(10_000)).toBe("100% · 10000 bps");
      expect(formatFeeRate(0)).toBe("0% · 0 bps");
    });

    it("never turns an unread or impossible rate into a number", () => {
      expect(formatFeeRate(null)).toBe(UNKNOWN);
      expect(formatFeeRate(undefined)).toBe(UNKNOWN);
      expect(formatFeeRate(Number.NaN)).toBe(UNKNOWN);
      expect(formatFeeRate(-1)).toBe(UNKNOWN);
    });
  });

  it("refuses to render an unread fee rate as zero", () => {
    // `api.ts` publishes `feeBps: null` when the chain read failed, and says why: zero would
    // claim the protocol charges nothing. The page has to keep that distinction.
    const view = ops({
      snapshot: snapshot({
        economics: { paidOutEth: "1", feesEth: "0", volumeEth: "1", paidSettlements: 1, feeBps: null },
      }),
    });
    expect(view.feeRate).toBe(UNKNOWN);
    expect(view.feeRate).not.toBe("0 bps");
    // The money beside it does not depend on that read, so it still prints — and a paid-out of
    // zero from a payload that says so is a measured zero, printed as one.
    expect(view.paidOut).toBe("1 ETH");
    expect(view.fees).toBe("0 ETH");
  });

  it("renders the whole of the economics as unknown when the snapshot has none", () => {
    const bare = { now: SERVER_NOW, trials: [], agents: [], hall: [], counts: {} } as unknown as ApiSnapshot;
    const view = ops({ snapshot: bare });
    expect(view.volume).toBe(UNKNOWN);
    expect(view.fees).toBe(UNKNOWN);
    expect(view.paidOut).toBe(UNKNOWN);
    expect(view.paidSettlements).toBe(UNKNOWN);
    expect(view.feeRate).toBe(UNKNOWN);
  });

  it("never renders a zero anywhere on the page when no endpoint answered", () => {
    const view = ops({});
    const cells = [
      view.indexedTo,
      view.head,
      view.lag,
      view.tolerance,
      view.dlqSize,
      view.dlqLastKind,
      view.dlqLastAge,
      view.total,
      view.volume,
      view.fees,
      view.paidOut,
      view.paidSettlements,
      view.feeRate,
      view.apiVerdict,
      view.readyVerdict,
      view.syncError,
      ...view.counts.map((c) => c.value),
    ];
    expect(cells.every((c) => c === UNKNOWN)).toBe(true);
    expect(cells).not.toContain("0");
  });
});
