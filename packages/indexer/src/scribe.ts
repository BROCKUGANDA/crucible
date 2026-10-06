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
import { RpcThrottler, withBackoff } from "@crucible/smith";

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
  /**
   * Blocks per backfill shard. 0 disables sharding (one big `getLogs`).
   *
   * "Sharding" here means partitioning the catch-up window by block range, not a second
   * database. A single `getLogs` over months of blocks can be tens of thousands of
   * events, which is slow and often larger than the RPC's response cap. Windowing it
   * into shards lets the gaps be fetched in parallel (still through `rpc`, one ceiling)
   * and keeps every individual call small.
   */
  shardSizeBlocks?: bigint;
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
  "IdentityLinked",
] as const;

// viem `getLogs` needs the full ABI event shape, not bare names.
const EVENTS = TRIALS_ABI.filter(
  (item): item is Extract<typeof item, { type: "event"; name: string }> =>
    item.type === "event" && EVENT_NAMES.includes(item.name as (typeof EVENT_NAMES)[number]),
);

export class Scribe {
  readonly client: PublicClient;
  private model: ReadModel = emptyModel();
  private cursor: bigint;
  private readonly blockTimes = new Map<bigint, number>();
  private running = false;
  /** One ceiling on concurrent RPC calls for the whole indexer. */
  private readonly rpc = new RpcThrottler(8);

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
    const head = await this.rpc.run(() =>
      withBackoff(() => this.client.getBlockNumber(), { operation: "scribe.getBlockNumber" }),
    );
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
    const shard = this.cfg.shardSizeBlocks ?? 0n;

    // No sharding configured: one honest call, same as before.
    if (shard <= 0n || to - from < shard) {
      return this.fetchLogsWindow(from, to);
    }

    const windows: [bigint, bigint][] = [];
    for (let start = from; start <= to; start += shard) {
      windows.push([start, start + shard - 1n > to ? to : start + shard - 1n]);
    }

    // Parallel across shards, still bounded by the single RPC throttler.
    const groups = await Promise.all(
      windows.map(([f, t]) => this.fetchLogsWindow(f, t)),
    );

    const merged = groups
      .flat()
      .sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : a.logIndex - b.logIndex));

    return merged;
  }

  private async fetchLogsWindow(from: bigint, to: bigint): Promise<EventLike[]> {
    const logs = (await this.rpc.run(() =>
      withBackoff(
        () =>
          this.client.getLogs({
            address: this.cfg.trialsAddress,
            events: EVENTS,
            fromBlock: from,
            toBlock: to,
          }),
        { operation: "scribe.getLogs" },
      ),
    )) as Log[];
    return logs.map(toEventLike);
  }

  private async recordBlockTimes(events: EventLike[]): Promise<void> {
    const blocks = [...new Set(events.map((e) => e.blockNumber))];
    await Promise.all(
      blocks.map(async (b) => {
        if (this.blockTimes.has(b)) return;
        try {
          await this.rpc.run(() =>
            withBackoff(
              () => this.client.getBlock({ blockNumber: b }).then((blk) => blk.timestamp),
              { operation: "scribe.getBlock" },
            ).then((ts) => this.blockTimes.set(b, Number(ts))),
          );
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

/**
 * A viem-decoded log carries its values on `args`, keyed by the ABI input names.
 *
 * `data` is the raw hex topics-and-topics payload, not a decoded record: iterating it
 * yields index→character pairs, so every `args.id` / `args.verdict` lookup came back
 * undefined and the coercion helpers turned the whole read model into zeros. A live
 * chain indexed through the old path produced a plausible-looking, entirely empty
 * projection — which is why this is asserted against a decoded fixture rather than
 * left to the replay tests, which build `args` by hand.
 */
export function toEventLike(log: Log): EventLike {
  const l = log as Log & { eventName?: string; args?: Record<string, unknown> };
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(l.args ?? {})) args[k] = v;
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
