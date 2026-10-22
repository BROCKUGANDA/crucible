import { describe, expect, it } from "vitest";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileState, MemoryState } from "../src/state.js";

/**
 * The durable store, on a real filesystem.
 *
 * This file is the reason the operator can be restarted at all, so it is tested against `tmpdir`
 * rather than a mock: a mock cannot show that the write landed, that a re-open read it back, or
 * that a half-written file is refused instead of silently treated as an empty memory.
 */

const SALT = `0x${"11".repeat(32)}` as const;
const COMMIT = `0x${"22".repeat(32)}` as const;

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "crucible-juror-state-"));
}

describe("FileState", () => {
  it("survives a close and a re-open with the salt intact", async () => {
    const dir = await tempDir();
    const first = await FileState.open(dir);
    await first.put({ trialId: 7, breakWins: true, salt: SALT, commit: COMMIT, sealedAt: 1 });
    await first.recordAbstention({ trialId: 8, reason: "no disclosure", phase: "abstain", at: 2 });
    await first.recordForfeit({ trialId: 9, reason: "window closed", at: 3 });

    // A new process: nothing in the old one carries over.
    const second = await FileState.open(dir);
    expect(await second.get(7)).toMatchObject({ breakWins: true, salt: SALT, commit: COMMIT });
    expect((await second.abstention(8))?.reason).toBe("no disclosure");
    expect((await second.forfeit(9))?.reason).toBe("window closed");
    expect((await second.pending()).map((s) => s.trialId)).toEqual([7]);
  });

  it("writes the seal atomically, leaving no temp file behind", async () => {
    const dir = await tempDir();
    const state = await FileState.open(dir);
    await state.put({ trialId: 7, breakWins: false, salt: SALT, commit: COMMIT, sealedAt: 1 });

    const entries = await readdir(dir);
    expect(entries).toEqual(["seat-state.json"]);
  });

  it("refuses a corrupt state file instead of starting empty", async () => {
    // Starting empty would let the loop commit again. `commitVote` reverts `AlreadyCommitted`,
    // so the seat would hammer a guaranteed revert while the commitment it lost the key to sat
    // on chain, unrevealable. Naming the file is the whole point of the refusal.
    const dir = await tempDir();
    await writeFile(path.join(dir, "seat-state.json"), "{ this is not json", "utf8");

    await expect(FileState.open(dir)).rejects.toThrow(/seat-state\.json is not valid JSON/);
  });

  it("drops a seal only when it is told to, and keeps it across a failed pass", async () => {
    const dir = await tempDir();
    const state = await FileState.open(dir);
    await state.put({ trialId: 7, breakWins: true, salt: SALT, commit: COMMIT, sealedAt: 1 });
    // A pass that threw never reaches `remove`, which is why a reveal can be retried.
    expect(await (await FileState.open(dir)).get(7)).not.toBeNull();

    await state.remove(7);
    expect(await (await FileState.open(dir)).get(7)).toBeNull();
  });

  it("clears an abstention when the seat finally has something to say", async () => {
    const dir = await tempDir();
    const state = await FileState.open(dir);
    await state.recordAbstention({ trialId: 7, reason: "the artifact was never published", phase: "abstain", at: 1 });
    await state.clearAbstention(7);

    expect(await (await FileState.open(dir)).abstention(7)).toBeNull();
  });

  it("keeps one seat's decisions out of another seat's memory", async () => {
    // Two instances, two directories, nothing shared. This is the case that a `{ ...EMPTY, sealed:
    // {}, abstained: {} }` initialiser silently broke: the third map, `givenUp`, kept pointing at the
    // module constant, so the first seat to forfeit a trial wrote that decision into `EMPTY` itself
    // and a second seat — with no state file of its own — inherited a give-up it had never made and
    // skipped a dispute it was perfectly able to judge.
    const a = await FileState.open(await tempDir());
    const b = await FileState.open(await tempDir());

    await a.recordForfeit({ trialId: 9, reason: "the window closed", at: 1 });
    await a.recordAbstention({ trialId: 10, reason: "no disclosure", phase: "abstain", at: 1 });
    await a.put({ trialId: 11, breakWins: true, salt: SALT, commit: COMMIT, sealedAt: 1 });

    expect(await b.forfeit(9)).toBeNull();
    expect(await b.abstention(10)).toBeNull();
    expect(await b.get(11)).toBeNull();
    expect(await b.pending()).toEqual([]);

    // And the first seat still holds all three, so the assertion above is about isolation rather
    // than about a store that records nothing at all.
    expect(await a.forfeit(9)).not.toBeNull();
    expect(await a.abstention(10)).not.toBeNull();
    expect((await a.pending()).map((s) => s.trialId)).toEqual([11]);
  });

  it("reads a state file written before forfeits existed", async () => {
    // An upgrade path, not a corruption: an older file simply carries no decisions of that kind.
    const dir = await tempDir();
    await writeFile(
      path.join(dir, "seat-state.json"),
      JSON.stringify({ version: 1, sealed: { "7": { trialId: 7, breakWins: true, salt: SALT, commit: COMMIT, sealedAt: 1 } }, abstained: {} }),
      "utf8",
    );

    const state = await FileState.open(dir);
    expect(await state.get(7)).not.toBeNull();
    expect(await state.forfeit(7)).toBeNull();
  });
});

describe("MemoryState", () => {
  it("keeps the same contract as the file-backed store", async () => {
    // Parity is asserted rather than assumed: the operator is tested against this class, so a
    // divergence between the two would mean the tests describe a store nobody deploys.
    const memory = new MemoryState();
    await memory.put({ trialId: 1, breakWins: true, salt: SALT, commit: COMMIT, sealedAt: 1 });
    await memory.recordAbstention({ trialId: 2, reason: "r", phase: "abstain", at: 1 });
    await memory.recordForfeit({ trialId: 3, reason: "r", at: 1 });

    expect(await memory.get(1)).not.toBeNull();
    expect(await memory.abstention(2)).not.toBeNull();
    expect(await memory.forfeit(3)).not.toBeNull();
    await memory.remove(1);
    await memory.clearAbstention(2);
    expect(await memory.pending()).toEqual([]);
    expect(await memory.abstention(2)).toBeNull();
  });
});
