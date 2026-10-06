import { describe, expect, it } from "vitest";
import {
  applyEvent,
  attachCids,
  attachSignatures,
  breakWindowEndsIn,
  buildSnapshot,
  deadlineEndsIn,
  emptyModel,
  hall,
  hydrateTimestamps,
  listTrials,
  MAX_SETTLEMENTS,
  replay,
  weiToEth,
  type EventLike,
  type ReadModel,
} from "../src/index.js";
import { toApiHallEntry } from "../src/api.js";

const SPONSOR = "0x1111111111111111111111111111111111111111";
const OPERATOR = "0x2222222222222222222222222222222222222222";
const SKEPTIC = "0x3333333333333333333333333333333333333333";
const TRIALS = "0x4444444444444444444444444444444444444444";

function ev(
  eventName: string,
  args: Record<string, unknown>,
  blockNumber = 1n,
): EventLike {
  return {
    blockNumber,
    transactionHash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
    logIndex: 0,
    address: TRIALS,
    eventName,
    args,
  };
}

/** The full happy path: trial → claim → run → break → verdict. */
function fullStory(): EventLike[] {
  return [
    ev("TrialCreated", {
      id: 1n,
      sponsor: SPONSOR,
      specCID: "0x" + "aa".repeat(32),
      testsCID: "0x" + "bb".repeat(32),
      reward: 10n ** 18n,
      bond: 2n * 10n ** 17n,
      deadline: 1_700_000_000n,
      breakWindow: 43_200n,
    }, 100n),
    ev("AgentRegistered", {
      agentId: 1n,
      operator: OPERATOR,
      runner: OPERATOR,
      metadataURI: "ipfs://manifest",
      stake: 10n ** 18n,
    }, 101n),
    ev("TrialClaimed", { id: 1n, agentId: 1n, bond: 2n * 10n ** 17n }, 102n),
    ev("RunSubmitted", { id: 1n, agentId: 1n, runHash: "0x" + "cc".repeat(32) }, 103n),
    ev("BreakFiled", {
      id: 1n,
      skeptic: SKEPTIC,
      proofCID: "0x" + "dd".repeat(32),
      stake: 10n ** 16n,
    }, 104n),
    ev("VerdictFinalized", { id: 1n, verdict: 1, agentPayout: 95n * 10n ** 16n }, 105n),
  ];
}

describe("applyEvent", () => {
  it("projects the full trial lifecycle", () => {
    const m = replay(fullStory());
    const t = m.trials.get(1)!;
    expect(t.sponsor).toBe(SPONSOR);
    expect(t.rewardWei).toBe(10n ** 18n);
    expect(t.bondWei).toBe(2n * 10n ** 17n);
    expect(t.agentId).toBe(1);
    expect(t.runHash).toBe("0x" + "cc".repeat(32));
    expect(t.breakSkeptic).toBe(SKEPTIC);
    expect(t.status).toBe("settled");
    expect(t.verdict).toBe("paid");
  });

  it("never mutates the model it is given", () => {
    const before = emptyModel();
    const after = applyEvent(before, fullStory()[0]!);
    expect(before.trials.size).toBe(0);
    expect(after.trials.size).toBe(1);
  });

  it("marks refunded verdicts distinctly from paid", () => {
    const m = replay([
      ev("TrialCreated", {
        id: 2n, sponsor: SPONSOR, specCID: "0xaa", testsCID: "0xbb",
        reward: 1n, bond: 1n, deadline: 1n, breakWindow: 1n,
      }),
      ev("VerdictFinalized", { id: 2n, verdict: 3, agentPayout: 0n }),
    ]);
    expect(m.trials.get(2)!.verdict).toBe("refunded");
  });

  it("ignores unknown events rather than throwing", () => {
    const m = replay([ev("SomethingNew", { id: 1n })]);
    expect(m.trials.size).toBe(0);
  });
});

describe("hydrateTimestamps", () => {
  it("replaces block numbers with real seconds", () => {
    const m = replay(fullStory());
    hydrateTimestamps(m, new Map([[100n, 1_699_000_000]]));
    expect(m.trials.get(1)!.createdAt).toBe(1_699_000_000);
  });

  it("leaves a timestamp alone when the block time is unknown", () => {
    const m = replay(fullStory());
    hydrateTimestamps(m, new Map());
    expect(m.trials.get(1)!.createdAt).toBe(100);
  });
});

describe("attachCids", () => {
  it("attaches the sponsor's CID text without touching the digests", () => {
    const m = replay(fullStory());
    attachCids(m, [{ trialId: 1, specCID: "bafySpec", testsCID: "bafyTests" }]);
    const t = m.trials.get(1)!;
    expect(t.specCID).toBe("bafySpec");
    expect(t.testsCID).toBe("bafyTests");
    expect(t.specDigest).toBe("0x" + "aa".repeat(32));
  });

  it("is what makes awaitingDisclosure false", () => {
    const m = replay(fullStory());
    expect(buildSnapshot(m, { now: 0 }).trials[0]!.awaitingDisclosure).toBe(true);
    attachCids(m, [{ trialId: 1, specCID: "s", testsCID: "t" }]);
    expect(buildSnapshot(m, { now: 0 }).trials[0]!.awaitingDisclosure).toBe(false);
  });

  it("ignores a disclosure for an unknown trial", () => {
    const m = replay(fullStory());
    expect(() => attachCids(m, [{ trialId: 999, specCID: "x" }])).not.toThrow();
  });
});

describe("attachSignatures", () => {
  it("carries the off-chain signature onto the run row", () => {
    const m = replay(fullStory());
    expect(m.runs.get(1)!.signature).toBeNull();
    attachSignatures(m, [{ trialId: 1, signature: "0xdead" }]);
    expect(m.runs.get(1)!.signature).toBe("0xdead");
  });
});

describe("countdowns", () => {
  it("counts down the run deadline while the trial is live", () => {
    // fullStory() ends in a verdict; use a trial that is still claimed
    const m = replay(fullStory().slice(0, 3));
    const t = listTrials(m)[0]!;
    expect(t.status).toBe("assigned");
    expect(deadlineEndsIn(t, 1_699_000_000)).toBe(1_000_000);
  });

  it("never returns a negative countdown", () => {
    const m = replay(fullStory().slice(0, 3));
    const t = listTrials(m)[0]!;
    expect(deadlineEndsIn(t, 1_900_000_000)).toBe(0);
  });

  it("stops the run countdown once settled", () => {
    const m = replay(fullStory());
    expect(deadlineEndsIn(listTrials(m)[0]!, 1_700_000_001)).toBeNull();
  });

  it("counts down the break window only while judging", () => {
    const m = replay(fullStory());
    const t = listTrials(m)[0]!;
    // status is settled, so no break countdown
    expect(breakWindowEndsIn(t, 1_700_000_000)).toBeNull();
  });
});

describe("hall", () => {
  it("excludes agents with no wins", () => {
    const m = replay(fullStory());
    m.agents.get(1)!.wins = 0;
    expect(hall(m)).toHaveLength(0);
  });

  it("ranks by wins, then survived, then fewest slashes", () => {
    const m = replay(fullStory());
    m.agents.set(2, { ...m.agents.get(1)!, id: 2, wins: 3, survived: 0, slashes: 0 });
    m.agents.set(3, { ...m.agents.get(1)!, id: 3, wins: 3, survived: 2, slashes: 1 });
    m.agents.get(1)!.wins = 5;
    const order = hall(m).map((e) => e.agentId);
    expect(order).toEqual([1, 3, 2]);
  });

  it("carries the linked ERC-8004 identity onto the hall entry, and serialises it", () => {
    // IdentityLinked is what connects a settlement to an agent's on-chain identity, so
    // the hall row — the proof a judge checks for — must surface it.
    const m = replay([
      ...fullStory(),
      {
        // Must come after AgentRegistered (block 101) and the verdict (105), or the
        // projection has no agent to attach this to.
        blockNumber: 110n,
        transactionHash: "0x" + "33".repeat(32),
        logIndex: 0,
        address: "0x4444444444444444444444444444444444444444" as `0x${string}`,
        eventName: "IdentityLinked",
        args: { agentId: 1n, identityAgentId: 4242n },
      },
    ]);

    const entry = hall(m)[0]!;
    expect(entry.identityAgentId).toBe(4242n);

    // The API must be JSON-safe; a bigint leaking through JSON.stringify throws.
    const apiRow = toApiHallEntry(entry);
    expect(apiRow.identityAgentId).toBe("4242");
    expect(() => JSON.stringify(apiRow)).not.toThrow();
  });
});

/** A readable, unique hash per block number, so a test can name the log it expects. */
function txFor(n: number | bigint): string {
  return `0x${BigInt(n).toString(16).padStart(64, "0")}`;
}

/** An event with its own transaction hash — the point is asserting on the exact one. */
function logged(
  eventName: string,
  args: Record<string, unknown>,
  blockNumber: bigint,
  transactionHash: string,
): EventLike {
  return { blockNumber, transactionHash, logIndex: 0, address: TRIALS, eventName, args };
}

const AGENT = {
  agentId: 1n,
  operator: OPERATOR,
  runner: OPERATOR,
  metadataURI: "ipfs://manifest",
  stake: 10n ** 18n,
};

function trialCreated(id: bigint) {
  return {
    id,
    sponsor: SPONSOR,
    specCID: "0x" + "aa".repeat(32),
    testsCID: "0x" + "bb".repeat(32),
    reward: 10n ** 18n,
    bond: 2n * 10n ** 17n,
    deadline: 1_700_000_000n,
    breakWindow: 43_200n,
  };
}

/**
 * The hall is a proof, not a scoreboard: every row must carry the log that minted the
 * win and the log that linked the ERC-8004 identity.
 */
describe("hall proofs", () => {
  const IDENTITY_TX = "0x" + "ab".repeat(32);
  const WIN_TX = "0x" + "cd".repeat(32);
  const SLASH_TX = "0x" + "ef".repeat(32);

  it("carries the verdict log that minted the win and the log that linked the identity", () => {
    const m = replay([
      logged("AgentRegistered", AGENT, 101n, txFor(101)),
      // The link lands before the trial runs; provenance is per-event, not per-order.
      logged("IdentityLinked", { agentId: 1n, identityAgentId: 4242n }, 102n, IDENTITY_TX),
      logged("TrialCreated", trialCreated(1n), 103n, txFor(103)),
      logged("TrialClaimed", { id: 1n, agentId: 1n, bond: 2n * 10n ** 17n }, 104n, txFor(104)),
      logged("RunSubmitted", { id: 1n, agentId: 1n, runHash: "0x" + "cc".repeat(32) }, 105n, txFor(105)),
      logged("VerdictFinalized", { id: 1n, verdict: 1, agentPayout: 95n * 10n ** 16n }, 106n, WIN_TX),
    ]);

    const entry = hall(m)[0]!;

    expect(entry.identity).not.toBeNull();
    expect(entry.identity!.txHash).toBe(IDENTITY_TX);
    expect(entry.identity!.blockNumber).toBe(102);
    expect(entry.identity!.identityAgentId).toBe(4242n);
    // IdentityLinked carries no registry address and the indexer never tails
    // IdentityRegistrySet, so the only honest name here is the log's emitter.
    expect(entry.identity!.emitter).toBe(TRIALS);
    // the legacy field still works for callers that have not moved to `identity`
    expect(entry.identityAgentId).toBe(4242n);

    expect(entry.settlements).toHaveLength(1);
    expect(entry.settlements[0]!.txHash).toBe(WIN_TX);
    expect(entry.settlements[0]!.blockNumber).toBe(106);
    expect(entry.settlements[0]!.trialId).toBe(1);
    expect(entry.settlements[0]!.verdict).toBe("paid");
    expect(entry.settlements[0]!.payoutWei).toBe(95n * 10n ** 16n);
    expect(entry.settlements[0]!.breakFiled).toBe(false);

    const api = toApiHallEntry(entry);
    expect(api.identity!.txHash).toBe(IDENTITY_TX);
    expect(api.identity!.identityAgentId).toBe("4242");
    expect(api.settlements[0]!.txHash).toBe(WIN_TX);
    expect(api.settlements[0]!.blockNumber).toBe(106);
    expect(api.settlements[0]!.payoutEth).toBe("0.95");
    expect(() => JSON.stringify(api)).not.toThrow();
    // alloyLocked was a hardcoded `true` over a registry read that never happened.
    expect(Object.hasOwn(api, "alloyLocked")).toBe(false);
  });

  it("records a slash as a settlement, so the hall can prove a loss as well as a win", () => {
    const m = replay([
      logged("TrialCreated", trialCreated(1n), 100n, txFor(100)),
      logged("AgentRegistered", AGENT, 101n, txFor(101)),
      logged("TrialClaimed", { id: 1n, agentId: 1n, bond: 2n * 10n ** 17n }, 102n, txFor(102)),
      logged("RunSubmitted", { id: 1n, agentId: 1n, runHash: "0x" + "cc".repeat(32) }, 103n, txFor(103)),
      logged("VerdictFinalized", { id: 1n, verdict: 1, agentPayout: 95n * 10n ** 16n }, 104n, WIN_TX),
      // a second trial, challenged and lost
      logged("TrialCreated", trialCreated(2n), 105n, txFor(105)),
      logged("TrialClaimed", { id: 2n, agentId: 1n, bond: 2n * 10n ** 17n }, 106n, txFor(106)),
      logged("RunSubmitted", { id: 2n, agentId: 1n, runHash: "0x" + "ee".repeat(32) }, 107n, txFor(107)),
      logged(
        "BreakFiled",
        { id: 2n, skeptic: SKEPTIC, proofCID: "0x" + "dd".repeat(32), stake: 10n ** 16n },
        108n,
        txFor(108),
      ),
      logged("VerdictFinalized", { id: 2n, verdict: 2, agentPayout: 0n }, 109n, SLASH_TX),
    ]);

    const entry = hall(m)[0]!;
    expect(entry.settlements[0]!.verdict).toBe("slashed");
    expect(entry.settlements[0]!.txHash).toBe(SLASH_TX);
    expect(entry.settlements[0]!.blockNumber).toBe(109);
    expect(entry.settlements[0]!.trialId).toBe(2);
    expect(entry.settlements[0]!.payoutWei).toBe(0n);
    expect(entry.settlements[0]!.breakFiled).toBe(true);
    expect(entry.settlements[1]!.verdict).toBe("paid");
    expect(entry.settlements[1]!.txHash).toBe(WIN_TX);
    expect(entry.settlements[1]!.breakFiled).toBe(false);
    expect(toApiHallEntry(entry).settlements[0]!.payoutEth).toBe("0");
  });

  it("caps settlements at the newest ten without touching the counters", () => {
    const events: EventLike[] = [
      logged("AgentRegistered", AGENT, 100n, txFor(100)),
      logged("IdentityLinked", { agentId: 1n, identityAgentId: 4242n }, 101n, IDENTITY_TX),
    ];
    // Twelve settled wins. The evidence list is bounded; the win count is not.
    for (let id = 1; id <= 12; id++) {
      const b = BigInt(200 + id * 3);
      events.push(
        logged("TrialCreated", trialCreated(BigInt(id)), b, txFor(b)),
        logged("TrialClaimed", { id: BigInt(id), agentId: 1n, bond: 2n * 10n ** 17n }, b + 1n, txFor(b + 1n)),
        logged("VerdictFinalized", { id: BigInt(id), verdict: 1, agentPayout: BigInt(id) }, b + 2n, txFor(b + 2n)),
      );
    }

    const entry = hall(replay(events))[0]!;
    expect(entry.settlements).toHaveLength(MAX_SETTLEMENTS);
    // newest first, and the two oldest settlements are the ones gone
    expect(entry.settlements.map((s) => s.trialId)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    expect(entry.settlements[0]!.txHash).toBe(txFor(236 + 2));
    expect(entry.settlements[0]!.blockNumber).toBe(238);
    expect(entry.settlements[9]!.txHash).toBe(txFor(209 + 2));
    expect(entry.wins).toBe(12);
  });

  it("replaying twice neither shares nor double-counts the evidence objects", () => {
    const events: EventLike[] = [
      ...fullStory(),
      logged("IdentityLinked", { agentId: 1n, identityAgentId: 4242n }, 110n, IDENTITY_TX),
      // a second trial, claimed but not yet settled, so the event below has something
      // to settle without rewriting the first one
      logged("TrialCreated", trialCreated(2n), 120n, txFor(120)),
      logged("TrialClaimed", { id: 2n, agentId: 1n, bond: 2n * 10n ** 17n }, 121n, txFor(121)),
    ];

    const base = replay(events);
    const settlement = base.agents.get(1)!.settlements[0]!;
    const identity = base.agents.get(1)!.identity!;

    // applyEvent clones and then mutates, so a shallow clone would hand the new
    // snapshot the *same* Settlement and IdentityProof objects as this one.
    const next = applyEvent(
      base,
      logged("VerdictFinalized", { id: 2n, verdict: 2, agentPayout: 0n }, 300n, SLASH_TX),
    );

    // the source snapshot is untouched: same evidence, same counters, no second copy
    expect(base.agents.get(1)!.settlements).toHaveLength(1);
    expect(base.agents.get(1)!.wins).toBe(1);
    expect(base.agents.get(1)!.slashes).toBe(0);

    expect(next.agents.get(1)!.settlements).toHaveLength(2);
    expect(next.agents.get(1)!.settlements[0]!.txHash).toBe(SLASH_TX);
    expect(next.agents.get(1)!.wins).toBe(1);
    expect(next.agents.get(1)!.slashes).toBe(1);
    expect(next.agents.get(1)!.settlements[1]).not.toBe(settlement);
    expect(next.agents.get(1)!.identity).not.toBe(identity);

    // writing through the derived snapshot must not reach the original's evidence
    next.agents.get(1)!.settlements[1]!.payoutWei = 7n;
    next.agents.get(1)!.identity!.identityAgentId = 999n;
    expect(settlement.payoutWei).toBe(95n * 10n ** 16n);
    expect(identity.identityAgentId).toBe(4242n);
    expect(base.agents.get(1)!.identityAgentId).toBe(4242n);

    // and a fresh replay of the same events reproduces it exactly, without aliasing
    const again = replay(events);
    expect(again.agents.get(1)!.settlements).toEqual(base.agents.get(1)!.settlements);
    expect(again.agents.get(1)!.settlements[0]).not.toBe(base.agents.get(1)!.settlements[0]);
  });

  it("leaves an unlinked agent with no identity proof rather than a fabricated one", () => {
    const entry = hall(replay(fullStory()))[0]!;
    expect(entry.identity).toBeNull();
    expect(entry.identityAgentId).toBeNull();
    expect(toApiHallEntry(entry).identity).toBeNull();
    // the settlement is still there — the win is provable even without the link
    expect(entry.settlements[0]!.txHash).toBe(txFor(105));
  });
});

describe("weiToEth", () => {
  it("renders whole and fractional amounts exactly", () => {
    expect(weiToEth(0n)).toBe("0");
    expect(weiToEth(10n ** 18n)).toBe("1");
    expect(weiToEth(95n * 10n ** 16n)).toBe("0.95");
    expect(weiToEth(1n)).toBe("0.000000000000000001");
  });

  it("never uses floating point, so no rounding error is possible", () => {
    expect(weiToEth(3333333333333333333n)).toBe("3.333333333333333333");
  });
});

describe("buildSnapshot", () => {
  it("produces a JSON-serialisable payload", () => {
    const m = replay(fullStory());
    const snap = buildSnapshot(m, { now: 1_699_000_000_000 });
    expect(() => JSON.stringify(snap)).not.toThrow();
    expect(snap.trials[0]!.rewardEth).toBe("1");
    expect(snap.trials[0]!.bondEth).toBe("0.2");
    expect(snap.counts.settled).toBe(1);
    expect(snap.counts.all).toBe(1);
  });

  it("uses the alloy registry for lock state when given", () => {
    const m = replay(fullStory());
    const snap = buildSnapshot(m, {
      now: 0,
      alloyState: (id) => ({
        locked: id === 1,
        tokenUri: `data:.../${id}`,
        tier: id === 1 ? 1 : 0,
      }),
    });
    expect(snap.agents[0]!.alloyLocked).toBe(true);
    expect(snap.agents[0]!.tokenUri).toContain("/1");
  });
});

/**
 * The tier is `AlloyRegistry` state. Scribe tails CrucibleTrials, so the projection
 * cannot know it, and the API must take it from the host's registry read — or say that
 * it does not know. "Unforged" is a measurement claim; a row that never asked the chain
 * has no business making one.
 */
describe("tier from the registry", () => {
  /** The same agent, settled-paid once: the chain would call that Iron (tier 1). */
  const model = () => replay(fullStory());

  it("keeps the tier out of the projection that has no source for it", () => {
    const m = model();
    // Not `0`, which is a value. Absent, because `AgentRegistered` never carries one and
    // `TierChanged` is a registry log this indexer does not read.
    expect(Object.hasOwn(m.agents.get(1)!, "tier")).toBe(false);
    expect(hall(m)[0]).not.toHaveProperty("tier");
    expect(hall(m)[0]).not.toHaveProperty("tierName");
  });

  it("takes the agent row's tier and name from alloyState", () => {
    const snap = buildSnapshot(model(), {
      now: 0,
      alloyState: () => ({ tier: 3, locked: true, tokenUri: null }),
    });
    expect(snap.agents[0]!.tier).toBe(3);
    expect(snap.agents[0]!.tierName).toBe("Steel");
  });

  it("puts the same registry tier on the hall row as on the agent row", () => {
    // `/hall` and `/agents` describing one agent differently is how a leaderboard loses
    // its credibility; both are rendered from the one read.
    const snap = buildSnapshot(model(), {
      now: 0,
      alloyState: () => ({ tier: 1, locked: true, tokenUri: null }),
    });
    expect(snap.hall[0]!.tier).toBe(1);
    expect(snap.hall[0]!.tierName).toBe("Iron");
    expect(snap.hall[0]!.tier).toBe(snap.agents[0]!.tier);
  });

  it("asks the registry once per agent per snapshot, not once per row", () => {
    const asked: number[] = [];
    buildSnapshot(model(), {
      now: 0,
      alloyState: (id) => {
        asked.push(id);
        return { tier: 1, locked: true, tokenUri: null };
      },
    });
    // One agent, appears on `agents` and on `hall`: still one read.
    expect(asked).toEqual([1]);
  });

  it("falls back to null rather than a fabricated tier when nobody read the registry", () => {
    const snap = buildSnapshot(model(), { now: 0 });
    expect(snap.agents[0]!.tier).toBeNull();
    expect(snap.agents[0]!.tierName).toBeNull();
    // the `agent.wins > 0` guess is gone from the lock field too
    expect(snap.agents[0]!.alloyLocked).toBeNull();
    expect(snap.hall[0]!.tier).toBeNull();
    expect(snap.hall[0]!.tierName).toBeNull();
    // nulls, not the string "Unforged" — a UI can tell unknown from unforged
    expect(JSON.stringify(snap)).not.toContain("Unforged");
  });

  it("names only a tier the table has, so an out-of-range read is not silently Unforged", () => {
    const snap = buildSnapshot(model(), {
      now: 0,
      alloyState: () => ({ tier: 9, locked: true, tokenUri: null }),
    });
    expect(snap.agents[0]!.tier).toBe(9);
    expect(snap.agents[0]!.tierName).toBeNull();
  });

  it("keeps an agent with no alloy at all at the registry's answer, tier 0", () => {
    // Distinct from the fallback above: here a read happened, and the registry said 0.
    const snap = buildSnapshot(model(), {
      now: 0,
      alloyState: () => ({ tier: 0, locked: false, tokenUri: null }),
    });
    expect(snap.agents[0]!.tier).toBe(0);
    expect(snap.agents[0]!.tierName).toBe("Unforged");
    expect(snap.agents[0]!.alloyLocked).toBe(false);
  });
});

/**
 * Ingest idempotency.
 *
 * `VerdictFinalized` is the only event in the protocol that *increments* anything, so it is
 * the only one a duplicate can inflate. Two ways a duplicate arrives and neither is exotic:
 * an overlapping shard boundary re-reads the same log, and a reorg re-mines the settling
 * block under a new transaction hash. Both would silently mint reputation the chain never
 * awarded — the exact failure the hall exists to make impossible.
 */
describe("ingest idempotency", () => {
  function settledTwice(events: EventLike[]): ReadModel {
    return replay([...events, ...events]);
  }

  it("does not double-count a win when the whole log list is replayed", () => {
    const model = settledTwice(fullStory());
    const agent = model.agents.get(1);
    expect(agent?.wins).toBe(1);
    expect(agent?.survived).toBe(1);
    expect(agent?.settlements.length).toBe(1);
    expect(hall(model)[0]?.wins).toBe(1);
  });

  it("does not double-count the same verdict applied twice in sequence", () => {
    const once = replay(fullStory());
    const verdict = fullStory().at(-1)!;
    const twice = applyEvent(applyEvent(once, verdict), verdict);
    expect(twice.agents.get(1)?.wins).toBe(1);
    expect(twice.agents.get(1)?.settlements.length).toBe(1);
  });

  it("does not double-count a reorged settlement carrying a new tx hash", () => {
    // A reorg replays the block, so the receipt is identical but the provenance is not —
    // a (txHash, logIndex) dedupe key alone would miss this one.
    const model = replay(fullStory());
    const reorged = {
      ...fullStory().at(-1)!,
      transactionHash: `0x${"ee".repeat(32)}`,
      blockNumber: 999n,
    };
    const after = applyEvent(model, reorged);
    expect(after.agents.get(1)?.wins).toBe(1);
    expect(after.agents.get(1)?.settlements).toHaveLength(1);
    expect(after.trials.get(1)?.status).toBe("settled");
  });

  it("keeps a slash counted once under the same replay", () => {
    const events = fullStory().map((e) =>
      e.eventName === "VerdictFinalized" ? { ...e, args: { ...e.args, verdict: 2 } } : e,
    );
    const model = settledTwice(events);
    expect(model.agents.get(1)?.slashes).toBe(1);
    expect(model.agents.get(1)?.wins).toBe(0);
  });

  it("still accepts a second, genuinely different settlement", () => {
    // Idempotency must not become immutability: trial 2 settling for the same agent is a
    // real second win and has to land.
    let model = replay(fullStory());
    model = applyEvent(
      model,
      ev("TrialCreated", {
        id: 2n,
        sponsor: SPONSOR,
        specCID: `0x${"11".repeat(32)}`,
        testsCID: `0x${"22".repeat(32)}`,
        reward: 10n ** 18n,
        bond: 2n * 10n ** 17n,
        deadline: 1_700_000_001n,
        breakWindow: 43_200n,
      }, 200n),
    );
    model = applyEvent(model, ev("TrialClaimed", { id: 2n, agentId: 1n, bond: 0n }, 201n));
    model = applyEvent(
      model,
      ev("RunSubmitted", { id: 2n, agentId: 1n, runHash: `0x${"33".repeat(32)}` }, 202n),
    );
    model = applyEvent(model, ev("VerdictFinalized", { id: 2n, verdict: 1, agentPayout: 1n }, 203n));

    expect(model.agents.get(1)?.wins).toBe(2);
    expect(model.agents.get(1)?.settlements).toHaveLength(2);
    expect(model.agents.get(1)!.settlements[0]!.trialId).toBe(2);
  });
});
