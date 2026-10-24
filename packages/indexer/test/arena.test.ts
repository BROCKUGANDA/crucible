import { describe, expect, it } from "vitest";
import { applyArenaEvent, emptyArenaModel, replayArena, type ArenaModel } from "../src/arena.js";
import type { EventLike } from "../src/model.js";

const SPONSOR = "0x976EA74026E726554dB657fA54763abd0C3a0aa9";
const AGENT = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";
const RUNNER = "0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7";

let logIndex = 0;

function log(eventName: string, args: Record<string, unknown>, blockNumber = 1n): EventLike {
  logIndex += 1;
  return {
    blockNumber,
    transactionHash: `0x${String(logIndex).padStart(64, "0")}`,
    logIndex,
    address: "0xfd471836031dc5108809d173a067e8486b9047a3",
    eventName,
    args,
  };
}

const posted = (id = 1) =>
  log("TrialPosted", {
    id: BigInt(id),
    sponsor: SPONSOR,
    reward: 500_000_000_000_000_000n,
    fee: 75_000_000_000_000_000n,
    specDigest: `0x${"11".repeat(32)}`,
    skepticWindow: 3600n,
  });

describe("the arena read model", () => {
  it("projects a posted trial into a row that is open and has no agent", () => {
    const m = replayArena([posted()]);
    const row = m.trials.get(1)!;
    expect(row.status).toBe("open");
    expect(row.sponsor).toBe(SPONSOR.toLowerCase());
    expect(row.rewardWei).toBe(500_000_000_000_000_000n);
    expect(row.feeWei).toBe(75_000_000_000_000_000n);
    expect(row.skepticWindow).toBe(3600);
    expect(row.agent).toBeNull();
    expect(row.runner).toBeNull();
  });

  it("records the claim and its bond, and advances the status", () => {
    const m = replayArena([
      posted(),
      log("TrialClaimed", { id: 1n, agent: AGENT, bond: 100_000_000_000_000_000n, claimDeadline: 1_700_000_000n }),
      log("RunnerSet", { id: 1n, runner: RUNNER }),
    ]);
    const row = m.trials.get(1)!;
    expect(row.status).toBe("claimed");
    expect(row.agent).toBe(AGENT.toLowerCase());
    expect(row.bondWei).toBe(100_000_000_000_000_000n);
    expect(row.claimDeadline).toBe(1_700_000_000);
    expect(row.runner).toBe(RUNNER.toLowerCase());
  });

  /**
   * The status chain is a place on a line, not a bag of labels. A shard overlap or a reorg
   * replays an earlier event after a later one, and the chain itself refuses to leave `Settled`
   * (`_settle` reverts `AlreadySettled`), so the projection has to refuse it too — otherwise a
   * re-read `TrialClaimed` re-opens a settled trial and the next count double-counts it.
   */
  it("never moves a trial backwards when an earlier event is replayed", () => {
    const forward = replayArena([
      posted(),
      log("TrialClaimed", { id: 1n, agent: AGENT, bond: 1n, claimDeadline: 2n }),
      log("RunSubmitted", { id: 1n }),
      log("DocketFrozen", { id: 1n }),
      log("PanelDrawn", { id: 1n, round: 1n }),
      log("Settled", { id: 1n }),
    ]);
    expect(forward.trials.get(1)!.status).toBe("settled");

    const backwards = applyArenaEvent(forward, log("TrialClaimed", { id: 1n, agent: AGENT, bond: 1n, claimDeadline: 2n }));
    expect(backwards.changed).toBe(false);
    expect(backwards.model.trials.get(1)!.status).toBe("settled");
  });

  it("does not rewrite the agent of a trial that has already claimed", () => {
    const m = replayArena([
      posted(),
      log("TrialClaimed", { id: 1n, agent: AGENT, bond: 1n, claimDeadline: 2n }),
      log("TrialClaimed", { id: 1n, agent: RUNNER, bond: 9n, claimDeadline: 9n }),
    ]);
    const row = m.trials.get(1)!;
    expect(row.agent).toBe(AGENT.toLowerCase());
    expect(row.bondWei).toBe(1n);
  });

  it("leaves the model untouched for an event it does not project", () => {
    const start: ArenaModel = replayArena([posted()]);
    const result = applyArenaEvent(start, log("AttestorSet", { attestor: AGENT, allowed: true }));
    expect(result.changed).toBe(false);
    expect(result.model).toBe(start);
  });

  it("ignores a claim for a trial it never saw posted", () => {
    const m = replayArena([log("TrialClaimed", { id: 7n, agent: AGENT, bond: 1n, claimDeadline: 2n })]);
    expect(m.trials.size).toBe(0);
  });

  it("bumps the version once per batch that changed something", () => {
    const empty = emptyArenaModel();
    expect(empty.version).toBe(0);
    expect(replayArena([posted()]).version).toBe(1);
    expect(replayArena([posted(), posted()]).version).toBe(1); // the second post is a duplicate id
    expect(replayArena([posted(), log("TrialClaimed", { id: 1n, agent: AGENT, bond: 1n, claimDeadline: 2n })]).version).toBe(2);
  });
});
