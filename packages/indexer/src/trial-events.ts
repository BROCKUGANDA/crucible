import { createPublicClient, http, decodeEventLog } from "viem";
import { foundry } from "viem/chains";
import { TRIALS_ABI } from "@crucible/smith";
import { toChainLog, type ChainLogWire } from "@crucible/frame";

const REPLAY_EVENTS = ["TrialCreated","TrialClaimed","RunSubmitted","BreakWindowOpened","BreakCommitted","BreakRevealed","VerdictSubmitted","TrialSettled"] as const;

export async function fetchTrialEvents(args: { rpcUrl: string; address: `0x${string}`; trialId: number; windowBlocks?: bigint }): Promise<ChainLogWire[]> {
  const client = createPublicClient({ chain: foundry, transport: http(args.rpcUrl) });
  const head = await client.getBlockNumber();
  const wb = args.windowBlocks ?? 200000n;
  const fromBlock = head > wb ? head - wb : 0n;
  const logs = await client.getLogs({ address: args.address, fromBlock, toBlock: head });
  const out: ChainLogWire[] = [];
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
      });
    } catch { /* skip undecodable */ }
  }
  return out;
}