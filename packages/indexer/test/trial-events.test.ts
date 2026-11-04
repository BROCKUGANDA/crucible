import { describe, expect, it } from "vitest";
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAbiItem,
  type PublicClient,
} from "viem";
import { TRIALS_ABI } from "@crucible/smith";
import { fetchTrialEvents } from "../src/trial-events.js";

/**
 * fetchTrialEvents is the data source behind the replay page and the live-room
 * SSE snapshot, so what is under test is the part a skeptic would attack: the
 * decode (a log that cannot be decoded is skipped, not fatal), the trial filter
 * (another trial's events must not appear), and the window arithmetic (the
 * block range asked of the daemon is the one the caller meant). The transport
 * is the seam — the logs themselves are really encoded from TRIALS_ABI, so the
 * decode path runs for real.
 */

const ADDR = "0x0000000000000000000000000000000000000001" as const;
const SPONSOR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const PAD_A = `0x${"aa".repeat(32)}` as `0x${string}`;
const PAD_B = `0x${"bb".repeat(32)}` as `0x${string}`;
const TX = `0x${"77".repeat(32)}` as `0x${string}`;

function encoded(
  name: "TrialCreated" | "RunSubmitted",
  args: Record<string, unknown>,
  block: bigint,
) {
  // This viem build has no encodeEventLog, so the log is composed the way the
  // function would: indexed inputs become topics, the rest is ABI-encoded data.
  const event = getAbiItem({ abi: TRIALS_ABI, name });
  const topics = encodeEventTopics({ abi: TRIALS_ABI, eventName: name, args: args as never });
  const dataInputs = event.inputs.filter((i) => !i.indexed);
  const dataArgs = dataInputs.map((i) => args[i.name as string]);
  return {
    address: ADDR,
    topics: topics as [`0x${string}`, ...`0x${string}`[]],
    data: encodeAbiParameters(dataInputs, dataArgs as never),
    blockNumber: block,
    transactionHash: TX,
    logIndex: 0,
  };
}

const createdOne = encoded(
  "TrialCreated",
  {
    id: 1n,
    sponsor: SPONSOR,
    specCID: PAD_A,
    testsCID: PAD_B,
    reward: 10n ** 18n,
    bond: 10n ** 17n,
    deadline: 1_800_000_000n,
    breakWindow: 600n,
  },
  5010n,
);
const submittedOne = encoded("RunSubmitted", { id: 1n, agentId: 3n, runHash: PAD_A }, 5020n);
const createdTwo = encoded(
  "TrialCreated",
  { id: 2n, sponsor: SPONSOR, specCID: PAD_A, testsCID: PAD_B, reward: 1n, bond: 1n, deadline: 1n, breakWindow: 1n },
  5030n,
);
const undecodable = {
  address: ADDR,
  topics: [`0x${"99".repeat(32)}` as `0x${string}`],
  data: "0x" as `0x${string}`,
  blockNumber: 5040n,
  transactionHash: TX,
  logIndex: 1,
};

type Seen = { fromBlock?: bigint; toBlock?: bigint };

function clientWith(logs: unknown[], head: bigint, seen: Seen = {}) {
  return {
    getBlockNumber: async () => head,
    getLogs: async (q: { fromBlock: bigint; toBlock: bigint }) => {
      seen.fromBlock = q.fromBlock;
      seen.toBlock = q.toBlock;
      return logs;
    },
  } as unknown as Pick<PublicClient, "getBlockNumber" | "getLogs">;
}

describe("fetchTrialEvents", () => {
  it("returns the trial's events decoded, with exact bigint text and the block number", async () => {
    const events = await fetchTrialEvents({
      rpcUrl: "http://127.0.0.1:8545",
      address: ADDR,
      trialId: 1,
      client: clientWith([createdOne, submittedOne], 5100n),
    });
    expect(events).toHaveLength(2);
    expect(events[0]!.eventName).toBe("TrialCreated");
    expect(events[0]!.blockNumber).toBe("5010");
    expect(events[0]!.transactionHash).toBe(TX);
    expect(events[0]!.args["id"]).toBe("1");
    expect(events[0]!.args["reward"]).toBe("1000000000000000000");
    expect(events[0]!.args["sponsor"]).toBe(SPONSOR);
    expect(events[1]!.eventName).toBe("RunSubmitted");
    expect(events[1]!.args["agentId"]).toBe("3");
  });

  it("never returns another trial's events", async () => {
    const events = await fetchTrialEvents({
      rpcUrl: "http://127.0.0.1:8545",
      address: ADDR,
      trialId: 1,
      client: clientWith([createdOne, createdTwo, undecodable, submittedOne], 5100n),
    });
    expect(events.map((e) => e.eventName)).toEqual(["TrialCreated", "RunSubmitted"]);
    expect(JSON.stringify(events)).not.toContain('"id":"2"');
  });

  it("skips a log it cannot decode rather than failing the read", async () => {
    const events = await fetchTrialEvents({
      rpcUrl: "http://127.0.0.1:8545",
      address: ADDR,
      trialId: 1,
      client: clientWith([undecodable], 5100n),
    });
    expect(events).toEqual([]);
  });

  it("asks the daemon for the caller's window, not the whole chain", async () => {
    const seen: Seen = {};
    await fetchTrialEvents({
      rpcUrl: "http://127.0.0.1:8545",
      address: ADDR,
      trialId: 1,
      windowBlocks: 100n,
      client: clientWith([], 5000n, seen),
    });
    expect(seen.fromBlock).toBe(4900n);
    expect(seen.toBlock).toBe(5000n);
  });

  it("falls back to chain origin when the default window outspans the chain", async () => {
    const seen: Seen = {};
    await fetchTrialEvents({
      rpcUrl: "http://127.0.0.1:8545",
      address: ADDR,
      trialId: 1,
      client: clientWith([], 5000n, seen),
    });
    expect(seen.fromBlock).toBe(0n);
    expect(seen.toBlock).toBe(5000n);
  });
});
