import { TRIALS_ABI } from "@crucible/smith";
import {
  createPublicClient,
  getAddress,
  http,
  type Address,
  type Chain,
  type Log,
  type PublicClient,
} from "viem";
import {
  attachCids,
  attachSignatures,
  emptyModel,
  hydrateTimestamps,
  replay,
  type EventLike,
  type ReadModel,
} from "./model.js";

/**
 * Live tailing of CrucibleTrials.
 *
 * Ponder is the intended production indexer; this is a dependency-light tailer
 * that produces the identical read model, so the API and frontend work without a
 * Postgres instance and the demo runs with one process.
 */

export interface IndexerConfig {
  trialsAddress: Address;
  alloyAddress: Address;
  chain: Chain;
  rpcUrl: string;
  fromBlock?: bigint;
  /** block interval to poll */
  pollMs?: number;
}

const EVENT_NAMES = [
  "TrialCreated",
  "AgentRegistered",
  "TrialClaimed",
  "RunSubmitted",
  "BreakFiled",
  "DisputeOpened",
  "VerdictFinalized",
  "StakeWithdrawn",
  "Withdrawn",
] as const;

export class Scribe {
  readonly client: PublicClient;
  private model: ReadModel = emptyModel();
  private cursor: bigint;
  private readonly blockTimes = new Map<bigint, number>();
  private running = false;

  constructor(private readonly cfg: IndexerConfig) {
    this.client = createPublicClient({
      chain: cfg.chain,
      transport: http(cfg.rpcUrl),
    }) as PublicClient;
    this.cursor = cfg.fromBlock ?? 0n;
  }

  get state(): ReadModel {
    return this.model;
  }

  /** Backfill from genesis (or fromBlock) to head, in one pass. */
  async sync(): Promise<ReadModel> {
    const head = await this.client.getBlockNumber();
    if (this.cursor > head) return this.model;
    const events = await this.fetchLogs(this.cursor, head);
    if (events.length > 0) {
      await this.recordBlockTimes(events);
      this.model = replay(events, this.model);
    }
    this.cursor = head + 1n;
    return this.model;
  }

  /** Poll until aborted. Resolves when stop() is called. */
  async watch(): Promise<void> {
    this.running = true;
    const interval = this.cfg.pollMs ?? 2000;
    while (this.running) {
      try {
        await this.sync();
      } catch (err) {
        // A dropped RPC must not kill the indexer; the next tick retries from the
        // same cursor, and the gap is re-scanned rather than skipped.
        console.error(`[scribe] sync failed: ${(err as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  stop(): void {
    this.running = false;
  }

  private async fetchLogs(from: bigint, to: bigint): Promise<EventLike[]> {
    const logs = (await this.client.getLogs({
      address: this.cfg.trialsAddress,
      events: [...EVENT_NAMES],
      fromBlock: from,
      toBlock: to,
    })) as Log[];
    return logs.map(toEventLike);
  }

  private async recordBlockTimes(events: EventLike[]): Promise<void> {
    const blocks = [...new Set(events.map((e) => e.blockNumber))];
    await Promise.all(
      blocks.map(async (b) => {
        if (this.blockTimes.has(b)) return;
        try {
          const blk = await this.client.getBlock({ blockNumber: b });
          this.blockTimes.set(b, Number(blk.timestamp));
        } catch {
          // A missing timestamp leaves the row on its block number; the next
          // hydrate pass fills it in.
        }
      }),
    );
  }

  /** Replace timestamps with real seconds after a sync. */
  hydrate(): ReadModel {
    this.model = hydrateTimestamps(this.model, this.blockTimes);
    return this.model;
  }

  attachCids(
    disclosure: { trialId: number; specCID?: string; testsCID?: string }[],
  ): ReadModel {
    attachCids(this.model, disclosure);
    return this.model;
  }

  attachSignatures(sigs: { trialId: number; signature: string }[]): ReadModel {
    attachSignatures(this.model, sigs);
    return this.model;
  }
}

export function toEventLike(log: Log): EventLike {
  const l = log as Log & { eventName?: string };
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(l.data ?? {})) args[k] = v;
  return {
    blockNumber: l.blockNumber ?? 0n,
    transactionHash: l.transactionHash ?? "",
    logIndex: l.logIndex ?? 0,
    address: getAddress(l.address),
    eventName: l.eventName ?? "",
    args,
  };
}

export { TRIALS_ABI };
