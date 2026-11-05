import { createPublicClient, http, decodeEventLog, type PublicClient } from "viem";
import { foundry } from "viem/chains";
import { TRIALS_ABI } from "@crucible/smith";
import type { ChainLogWire } from "@crucible/frame";

const REPLAY_EVENTS = ["TrialCreated","TrialClaimed","RunSubmitted","BreakWindowOpened","BreakCommitted","BreakRevealed","VerdictSubmitted","TrialSettled"] as const;

/** A chain log carrying the block's own timestamp, when the chain could answer. */
export type ChainEvent = ChainLogWire & {
  /** Unix seconds from the log's block. Absent when the block read failed — the
   * consumer shows "observed now" rather than a time the chain never stated. */
  blockTimestamp?: string;
};

export async function fetchTrialEvents(args: {
  rpcUrl: string;
  address: `0x${string}`;
  trialId: number;
  windowBlocks?: bigint;
  /**
   * Test seam: a prebuilt client answering getBlockNumber, getLogs and getBlock.
   * Production leaves it undefined and gets one built on rpcUrl — the decode path
   * under test is the real one; only the transport is stood in.
   */
  client?: Pick<PublicClient, "getBlockNumber" | "getLogs" | "getBlock">;
}): Promise<ChainEvent[]> {
  const client = args.client ?? createPublicClient({ chain: foundry, transport: http(args.rpcUrl) });
  const head = await client.getBlockNumber();
  const wb = args.windowBlocks ?? 200000n;
  const fromBlock = head > wb ? head - wb : 0n;
  const logs = await client.getLogs({ address: args.address, fromBlock, toBlock: head });

  // Block timestamps are fetched per distinct block and cached: a trial's whole
  // history is a handful of blocks, so this is a handful of reads — not one per
  // event, and not a fabricated "now" stamped on events that happened earlier.
  const blockTimes = new Map<bigint, string>();
  const timestampFor = async (blockNumber: bigint): Promise<string | undefined> => {
    if (blockTimes.has(blockNumber)) return blockTimes.get(blockNumber);
    try {
      const block = await client.getBlock({ blockNumber });
      const ts = block.timestamp.toString();
      blockTimes.set(blockNumber, ts);
      return ts;
    } catch {
      return undefined; // the chain did not answer; absence beats invention
    }
  };

  const out: ChainEvent[] = [];
  for (const log of logs) {
    try {
      const d = decodeEventLog({ abi: TRIALS_ABI, data: log.data, topics: log.topics as [`0x${string}`, ...`0x${string}`[]] });
      if (!REPLAY_EVENTS.includes(d.eventName as any)) continue;
      const argsObj = (d.args ?? {}) as Record<string, unknown>;
      if (Number(argsObj.id ?? argsObj.trialId ?? 0) !== args.trialId) continue;
      out.push({
        blockNumber: log.blockNumber.toString(),
        transactionHash: log.transactionHash,
        logIndex: log.logIndex,
        address: args.address,
        eventName: d.eventName,
        args: Object.fromEntries(Object.entries(argsObj).map(([k,v]) => [k, typeof v === "bigint" ? v.toString() : v])),
        blockTimestamp: await timestampFor(log.blockNumber),
      });
    } catch { /* skip undecodable */ }
  }
  return out;
}
