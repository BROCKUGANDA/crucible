import { TRIALS_ABI } from "@crucible/smith";
import {
  createPublicClient,
  encodeEventTopics,
  getAddress,
  hexToBytes,
  http,
  keccak256,
  type Address,
  type Chain,
  type Hex,
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
import { RpcThrottler, withBackoff, BreakerOpen, CircuitBreaker } from "@crucible/smith";

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
   * Called for every failure the indexer survives — a dropped sync tick, a window it
   * refused to advance across. The API feeds this into its dead-letter queue, so an
   * operator sees a failing indexer without reading this process's stdout.
   */
  onError?: (kind: string, detail: string) => void;
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

/** Every topic0 this indexer would accept, for the block-bloom cross-check below. */
const TOPIC0S: `0x${string}`[] = EVENTS.map(
  (e) => encodeEventTopics({ abi: TRIALS_ABI, eventName: e.name })[0] as `0x${string}`,
);

/**
 * Does this block's logsBloom possibly contain `topic`?
 *
 * A bloom is a set of three bits derived from keccak256(topic), and it answers "maybe" or
 * "definitely not" — never "yes". That asymmetry is exactly what makes it useful here: a
 * "definitely not" for every block in a window is independent evidence that an empty
 * `getLogs` was the truth rather than a node that answered nothing.
 */
export function bloomMayContain(bloom: Hex, topic: `0x${string}`): boolean {
  const bytes = hexToBytes(bloom);
  // keccak256 over the raw 32 bytes of the topic, exactly as the log bloom defines it.
  const digest = hexToBytes(keccak256(topic));

  for (let i = 0; i < 3; i++) {
    // Three 11-bit offsets into a 2048-bit filter, from six big-endian bytes.
    const pair = ((digest[i * 2] ?? 0) << 8) | (digest[i * 2 + 1] ?? 0);
    const bit = pair & 0x7ff;
    const byte = bytes[255 - (bit >> 3)] ?? 0;
    if (((byte >> (bit & 7)) & 1) === 0) return false;
  }
  return true;
}

/** How far the bloom cross-check will walk a quiet window, in blocks. */
const BLOOM_PROBE_LIMIT = 64n;

export interface ScribeStatus {
  /** highest block the node reported */
  head: bigint | null;
  /** first block not yet ingested; the index covers everything below it */
  indexedTo: bigint;
  /** why the last tick did not advance, or null when it did */
  syncError: string | null;
}

export class Scribe {
  readonly client: PublicClient;
  /**
   * The node is this indexer's only external dependency, so it gets exactly one breaker.
   * Every tick already spends four `withBackoff` retries inside `sync()`; a node that is
   * down for ten minutes must not turn that into a fresh four-retry storm every 2s. Hosts
   * publish `breaker.status()` from their health endpoint.
   */
  readonly breaker = new CircuitBreaker({
    name: "scribe.rpc",
    threshold: 3,
    windowMs: 60_000,
    cooldownMs: 30_000,
  });
  private model: ReadModel = emptyModel();
  private cursor: bigint;
  private readonly blockTimes = new Map<bigint, number>();
  private running = false;
  private head: bigint | null = null;
  private syncError: string | null = null;
  /** The trip this process last reported, so an outage writes one line rather than one per tick. */
  private lastTripReportedAt: number | null = null;
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

  /**
   * What the index actually covers, so a reader can tell an empty chain apart from an
   * indexer that stopped listening. Without this the API answers `200 ok:true` with zero
   * trials either way, and a silently-empty leaderboard is indistinguishable from a quiet
   * protocol — which is the difference between a demo and an outage nobody notices.
   */
  get status(): ScribeStatus {
    return { head: this.head, indexedTo: this.cursor, syncError: this.syncError };
  }

  /**
   * One pass, under the breaker — the only sync there is, so no caller can pick an unprotected
   * route by accident. A fresh breaker admits its first call, so the boot backfill comes through
   * here too: a node that is down at boot is the outage this is for.
   */
  async sync(): Promise<ReadModel> {
    return this.breaker.exec(() => this.syncOnce());
  }

  /** Backfill from genesis (or fromBlock) to head, in one pass. */
  private async syncOnce(): Promise<ReadModel> {
    const head = await this.rpc.run(() =>
      withBackoff(() => this.client.getBlockNumber(), { operation: "scribe.getBlockNumber" }),
    );
    this.head = head;
    if (this.cursor > head) return this.model;
    const events = await this.fetchLogs(this.cursor, head);

    if (events.length > 0) {
      await this.recordBlockTimes(events);
      this.model = replay(events, this.model);
      // Applied per batch, not once at startup. `createdAt` and `runAt` are written as block
      // numbers and only become seconds here, so a trial that arrived after boot would keep
      // a block number as its timestamp — and `breakWindowEndsAt` is `runAt + breakWindow`,
      // which turns into a countdown from 1970. The old code called `hydrate()` once, in
      // server startup, and the comment in `recordBlockTimes` promised "the next hydrate
      // pass" that nothing ever ran.
      const touched = new Set<number>();
      for (const e of events) {
        const id = Number(e.args.id ?? NaN);
        if (Number.isInteger(id)) touched.add(id);
      }
      hydrateTimestamps(this.model, this.blockTimes, touched);
      // Bounded to one batch: every entry here has now been applied to a row.
      this.blockTimes.clear();
      this.cursor = head + 1n;
      this.syncError = null;
      return this.model;
    }

    // An empty answer is the dangerous one: `getLogs` cannot distinguish "there were no
    // events" from "this node has no answer for that range", and the old code advanced the
    // cursor either way. One such reply — a truncated response, a pruned archive node, a
    // proxy with a cap — skipped the entire chain permanently and `/hall` answered `[]` with
    // HTTP 200. So the cursor only moves across a quiet window once the blocks themselves
    // say nothing was there to find.
    if (await this.windowIsQuiet(this.cursor, head)) {
      this.cursor = head + 1n;
      this.syncError = null;
    } else {
      this.syncError = `getLogs returned nothing for blocks ${this.cursor}–${head} but a logsBloom there may contain a Crucible event`;
      console.error(`[scribe] refusing to advance cursor: ${this.syncError}`);
      this.cfg.onError?.("stall", this.syncError);
    }
    return this.model;
  }

  /**
   * Independent evidence that a window really held no matching events.
   *
   * Reads the blocks' `logsBloom` rather than asking the same `getLogs` again — a second
   * identical answer from the same node proves nothing. Windows wider than the probe limit
   * are treated as *not* confirmed, because advancing on a partial check is the same bug
   * wearing a lab coat; the caller re-reads the whole range next tick instead.
   */
  private async windowIsQuiet(from: bigint, to: bigint): Promise<boolean> {
    const width = to - from + 1n;
    if (width <= 0n) return true;
    if (width > BLOOM_PROBE_LIMIT) return false;

    for (let n = from; n <= to; n++) {
      const block = await this.rpc.run(() =>
        withBackoff(
          () => this.client.getBlock({ blockNumber: n }),
          { operation: "scribe.getBlock" },
        ),
      );
      const bloom = block.logsBloom;
      if (!bloom || bloom === "0x") continue;
      if (TOPIC0S.some((t) => bloomMayContain(bloom, t))) return false;
    }
    return true;
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
        const detail = (err as Error).message;
        // A refused tick carries no news: the failure that tripped the breaker already
        // reported itself, and every tick until the cooldown ends would report the same
        // sentence. One line per trip, or an outage writes the log and the DLQ ring dead.
        const trippedAt = err instanceof BreakerOpen ? this.breaker.status().openedAt : null;
        if (trippedAt === null || trippedAt !== this.lastTripReportedAt) {
          this.lastTripReportedAt = trippedAt;
          console.error(
            trippedAt === null ? `[scribe] sync failed: ${detail}` : `[scribe] sync refused: ${detail}`,
          );
          this.cfg.onError?.(trippedAt === null ? "sync" : "tripped", detail);
        }
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
          // A missing timestamp leaves that row on its block number for this tick. The row
          // is not marked hydrated, so the next sync re-reads the block and applies it —
          // `blockTimes` is only cleared for entries that were actually consumed below.
        }
      }),
    );
  }

  /** Replace timestamps with real seconds after a sync. */
  hydrate(): ReadModel {
    hydrateTimestamps(this.model, this.blockTimes);
    this.blockTimes.clear();
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
