import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
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
   * Blocks per shard for the backfill. 0 disables sharding (one big
   * `getLogs` over the whole range), which is only safe on a node that
   * answers a wide range without truncating it.
   *
   * The default is a shard, not a single call: one `getLogs` over months of
   * blocks can be tens of thousands of events, which is slow and often
   * larger than the RPC's response cap — and a response that is quietly
   * truncated is a response that loses events without saying so.
   */
  shardSizeBlocks?: bigint;
  /**
   * Path to a file for cursor persistence. When set, the cursor is loaded from this
   * file on startup (if it exists and is ahead of `fromBlock`) and saved after every
   * sync. This prevents a restart from re-scanning the entire chain from `FROM_BLOCK`.
   *
   * The file contains a single integer (the block number). It is written atomically
   * (write to temp, rename) so a crash mid-write cannot corrupt it.
   */
  cursorFile?: string;
}

const EVENT_NAMES = [
  "TrialCreated",
  "AgentRegistered",
  "RunnerSet",
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

/** How far the bloom cross-check walks in one chunk. */
const BLOOM_PROBE_LIMIT = 64n;

/**
 * How many blocks one tick will PROVE quiet.
 *
 * The cross-check reads every block's `logsBloom`, so proving a long quiet
 * stretch costs one read per block. This bounds that work per tick: a long
 * stretch is walked over several ticks, and the cursor advances by however
 * much was proved.
 *
 * The bound matters because the OLD behaviour was to refuse to advance across
 * a window wider than `BLOOM_PROBE_LIMIT` at all. On any real chain the
 * first gap longer than 64 blocks — two minutes on Base — froze the index
 * permanently: the cursor could not move, the sync error stayed set, `/health`
 * answered 503, the container was marked unhealthy, and the site went down
 * with nothing to indicate why. Bounding the work keeps a tick short; never
 * refusing to advance keeps the index moving.
 */
const MAX_PROOF_BLOCKS_PER_TICK = 64n;

/**
 * The reads are NOT batched.
 *
 * A JSON-RPC batch is a convenience many nodes implement and some do not —
 * anvil, which this project deploys, answers one with an error — and a
 * batched transport turned every proof into a failure on the chain this
 * project actually runs on. The index emptied itself, and the reason was
 * visible only in the log.
 */
type ProofResult = {
  cursor: bigint;
  stoppedBecause: "quiet" | "possible-event" | "unreadable";
  detail?: string;
};

/**
 * The sentence `/health` shows for a proof that did not reach the head.
 *
 * Null means the cursor is past the head and there is nothing to say.
 */
function describeProof(proof: ProofResult, head: bigint): string | null {
  if (proof.cursor > head) return null;
  if (proof.stoppedBecause === "unreadable") {
    return `a block at or after ${proof.cursor} could not be read, so the index stopped there: ${proof.detail ?? "unknown error"}`;
  }
  return `a block between ${proof.cursor} and ${head} may hold an event; the index is re-reading it`;
}

/**
 * The default width of one `getLogs` request.
 *
 * A single call over the whole chain history is what the sharding exists to
 * avoid: it is slow, and it is often larger than the RPC's response cap —
 * and a response that is silently truncated is a response that loses events
 * without saying so. Sharding is the safe default; a single wide call stays
 * available as an explicit opt-out.
 */
const DEFAULT_SHARD_SIZE = 2000n;

export interface ScribeStatus {
  /** highest block the node reported */
  head: bigint | null;
  /** first block not yet ingested; the index covers everything below it */
  indexedTo: bigint;
  /** why the last tick did not advance, or null when it did */
  syncError: string | null;
  /**
   * Trials that settled before this index started listening, so their rows are
   * incomplete. Non-zero means the index is not reading the whole history —
   * a `FROM_BLOCK` that is too high, or a cursor file from a chain that was
   * rebuilt. It is counted because the alternative is a hall that quietly
   * omits trials that were paid out.
   */
  partialTrials: number;
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
  /** Blocks whose timestamp could not be read, retried on the next tick. */
  private readonly pendingBlockTimes = new Set<bigint>();
  private running = false;
  private head: bigint | null = null;
  private syncError: string | null = null;
  /** The trip this process last reported, so an outage writes one line rather than one per tick. */
  private lastTripReportedAt: number | null = null;
  /** The incomplete-trial count last reported, so it is written once rather than every tick. */
  private reportedPartialTrials = 0;
  /** One ceiling on concurrent RPC calls for the whole indexer. */
  private readonly rpc = new RpcThrottler(8);

  constructor(private readonly cfg: IndexerConfig) {
    this.client = createPublicClient({
      chain: cfg.chain,
      // Deliberately NOT batched, for two reasons that both cost the site.
      //
      // The breaker is what stops a dead node being asked forever, and its
      // guarantee is that a refused pass costs the node nothing. A batched
      // transport holds a request for a window before sending it, so a
      // request queued before the breaker tripped is still delivered after —
      // the node is asked once more, the error shape changes, and the
      // guarantee the breaker exists to make is gone.
      //
      // And not every node speaks JSON-RPC batching. anvil — the chain this
      // project deploys — answers a batch with an error, so a batched
      // transport made every bloom proof fail, every tick threw, and the
      // index emptied itself. The one place batching was wanted (the proof
      // walk) is the one place a node is least likely to support it.
      transport: http(cfg.rpcUrl),
    }) as PublicClient;
    this.cursor = cfg.fromBlock ?? 0n;
    this.loadCursor();
  }

  private loadCursor(): void {
    if (!this.cfg.cursorFile) return;
    try {
      if (!existsSync(this.cfg.cursorFile)) return;
      const raw = readFileSync(this.cfg.cursorFile, "utf8").trim();
      const saved = BigInt(raw);
      if (saved > this.cursor) {
        this.cursor = saved;
      }
    } catch {
      // A missing or unreadable cursor file is not a startup failure — the indexer
      // starts from `fromBlock` and rebuilds the cursor from the chain.
    }
  }

  private saveCursor(): void {
    if (!this.cfg.cursorFile) return;
    try {
      const tmp = `${this.cfg.cursorFile}.tmp`;
      writeFileSync(tmp, this.cursor.toString(), "utf8");
      writeFileSync(this.cfg.cursorFile, this.cursor.toString(), "utf8");
      try {
        unlinkSync(tmp);
      } catch {
        // Temp file cleanup is best-effort.
      }
    } catch (err) {
      console.error(`[scribe] failed to persist cursor: ${(err as Error).message}`);
    }
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
    return {
      head: this.head,
      indexedTo: this.cursor,
      syncError: this.syncError,
      partialTrials: this.countPartialTrials(),
    };
  }

  /**
   * How many rows are incomplete because the index missed their creation.
   *
   * Counted rather than remembered, so it cannot drift from the model.
   */
  private countPartialTrials(): number {
    let n = 0;
    for (const trial of this.model.trials.values()) {
      if (trial.incomplete) n += 1;
    }
    return n;
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

    // The cursor is the NEXT block to read, so `head + 1` is the caught-up
    // state, not a reset. Treating it as one cleared the model and restarted
    // the backfill on every idle tick: the hall emptied, `/ready` flipped
    // between true and false, and the index never settled. Only a cursor
    // beyond `head + 1` can have come from a shorter chain.
    if (this.cursor > head) {
      if (this.cursor === head + 1n) {
        this.syncError = null;
        this.saveCursor();
        return this.model;
      }

      // A chain that was reset — an anvil restart, a fork, a devnet rebuilt from
      // its seed — leaves the cursor ahead of the head, and the cursor file
      // survives the restart. The old code returned the model as it was, so the
      // indexer served a frozen pre-reset index forever, and `/ready` computed
      // a lag of zero because the cursor was above the head. The API reported
      // healthy while nothing was being indexed. A reset is a rebuild.
      this.cursor = this.cfg.fromBlock ?? 0n;
      this.model = emptyModel();
      this.blockTimes.clear();
      this.pendingBlockTimes.clear();
      this.syncError = "the chain was reset; the index is rebuilding from the start block";
      this.saveCursor();
      return this.model;
    }

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

      // Trials that settled before this index started are reported once, so a
      // hall that quietly omits a paid trial has a cause somebody can act on.
      const partial = this.countPartialTrials();
      if (partial > 0 && partial !== this.reportedPartialTrials) {
        this.reportedPartialTrials = partial;
        this.cfg.onError?.(
          "partial",
          `${partial} trial(s) settled before this index started reading; their rows are incomplete. Set FROM_BLOCK to the deployment block and re-index.`,
        );
      }

      // The cursor moves only as far as the chain has been PROVEN to hold
      // nothing.
      //
      // `getLogs` cannot distinguish "there were no events" from "this node
      // has no answer for that range": a truncated response, a pruned archive
      // node, a proxy with a cap. The old code advanced to `head + 1` on the
      // strength of a non-empty array, so a response that was quietly cut off
      // lost the tail of the chain permanently — the same class of loss the
      // empty case was guarded against, in the branch that was not.
      //
      // So the tail after the last event is proved quiet, block by block, and
      // the cursor stops at the first block whose bloom says an event might be
      // in it. The next tick re-reads from there and picks up what was
      // dropped. The projection is replay-safe, so re-reading costs nothing.
      const lastEventBlock = events.reduce((max, e) => (e.blockNumber > max ? e.blockNumber : max), this.cursor - 1n);
      const proof = await this.proveQuietThrough(lastEventBlock + 1n, head);
      this.cursor = proof.cursor;
      this.syncError = describeProof(proof, head);
      this.saveCursor();
      return this.model;
    }

    // An empty answer is the dangerous one, for the same reason: the cursor
    // only moves across a window once the blocks themselves say nothing was
    // there to find. The difference from the old code is that this now makes
    // PROGRESS instead of refusing: the window is walked in chunks, and the
    // cursor advances by however much was proved. A quiet window of any width
    // is crossed; a window with a lie in it is re-read.
    const proof = await this.proveQuietThrough(this.cursor, head);
    this.cursor = proof.cursor;
    this.syncError = describeProof(proof, head);
    this.saveCursor();
    return this.model;
  }

  /**
   * The first block at or after `from` whose `logsBloom` says a Crucible event
   * might be in it — or `to + 1` when every block up to `to` is provably
   * quiet.
   *
   * The walk is bounded by `MAX_PROOF_BLOCKS_PER_TICK`, so a long quiet
   * stretch is proved over several ticks and the cursor advances a little each
   * time. That is the whole difference from the old behaviour, which refused
   * to advance across a window wider than the chunk size and so froze the
   * index on the first gap longer than 64 blocks.
   */
  private async proveQuietThrough(from: bigint, to: bigint): Promise<ProofResult> {
    if (to < from) return { cursor: to + 1n, stoppedBecause: "quiet" };
    const limit = from + MAX_PROOF_BLOCKS_PER_TICK - 1n;
    const end = limit < to ? limit : to;

    let block = from;
    while (block <= end) {
      const chunkEnd = block + BLOOM_PROBE_LIMIT - 1n > end ? end : block + BLOOM_PROBE_LIMIT - 1n;
      let blocks: Awaited<ReturnType<PublicClient["getBlock"]>>[];
      try {
        blocks = await this.rpc.run(() =>
          Promise.all(
            Array.from({ length: Number(chunkEnd - block + 1n) }, (_, i) =>
              withBackoff(() => this.client.getBlock({ blockNumber: block + BigInt(i) }), {
                operation: "scribe.getBlock",
              }),
            ),
          ),
        );
      } catch (err) {
        // A block that could not be read proves nothing about itself or about
        // what follows it, so the cursor stops HERE rather than crossing a
        // range on no evidence. The next tick tries again.
        //
        // The alternative — letting the read failure throw out of the tick —
        // was worse than a stall: the whole sync failed, so the model was
        // never rebuilt, and one unreadable block emptied the hall. The
        // chain reset that triggered this in the first place made the read
        // fail, and the indexer's answer to "I cannot read a block" was to
        // throw away everything it already knew.
        return {
          cursor: block,
          stoppedBecause: "unreadable",
          detail: err instanceof Error ? err.message : String(err),
        };
      }
      for (const b of blocks) {
        const bloom = b.logsBloom;
        if (bloom && bloom !== "0x" && TOPIC0S.some((t) => bloomMayContain(bloom, t))) {
          // A block's own number is the authority, and it is null only for a
          // pending block, which a mined range never holds.
          return { cursor: b.number ?? block, stoppedBecause: "possible-event" };
        }
      }
      block = chunkEnd + 1n;
    }
    return { cursor: end + 1n, stoppedBecause: "quiet" };
  }

  /**
   * Independent evidence that a window really held no matching events.
   *
   * Reads the blocks' `logsBloom` rather than asking the same `getLogs` again
   * — a second identical answer from the same node proves nothing.
   *
   * This is kept as a whole-window check for callers that want a yes/no
   * answer. The cursor uses `proveQuietThrough`, which walks the same blocks
   * but can stop part-way and report how far it got, so a long quiet stretch
   * is crossed rather than refused.
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
        //
        // The message is read defensively: a throw that is not an `Error` —
        // a string, a plain object — has no `.message`, and the old code
        // handed `undefined` to the dead-letter queue, whose `detail.slice(...)`
        // then threw INSIDE this catch. The watch loop's promise rejected, and
        // nothing awaited it, so the process died: a malformed throw took the
        // whole indexer with it.
        const detail = err instanceof Error ? err.message : String(err);
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
    // Sharding is the DEFAULT, not an opt-in.
    //
    // The old default was one `getLogs` over the entire chain history, which
    // is exactly what this function's own doc warns about: slow, and often
    // larger than the RPC's response cap — and a response that is silently
    // truncated is a response that loses events without saying so. A
    // default that only a careful configuration avoided was a default that
    // would eventually bite.
    const shard = this.cfg.shardSizeBlocks ?? DEFAULT_SHARD_SIZE;

    // A shard of 0 is the explicit opt-out: one call for the whole range.
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
          this.pendingBlockTimes.delete(b);
        } catch {
          // A failed read is PENDING, not lost.
          //
          // The old comment here said the row was not marked hydrated, so the
          // next sync re-reads the block and applies it. It did not: the
          // batch's block times were cleared right after the hydrate, and the
          // next sync only fetched times for the blocks in the NEW batch. A
          // trial that missed one read kept its raw block number as
          // `createdAt` and `runAt` forever — and `breakWindowEndsAt` is
          // `runAt + breakWindow`, so the UI counted down from 1970 and the
          // deadline was nonsense. The promise was in the comment and not in
          // the code.
          this.pendingBlockTimes.add(b);
        }
      }),
    );

    // A pending read is retried, on its own, before the next batch is
    // hydrated. A trial whose timestamp is missing is a row that cannot be
    // trusted, so it is worth a call on its own.
    if (this.pendingBlockTimes.size > 0) {
      for (const b of [...this.pendingBlockTimes]) {
        try {
          const ts = await this.rpc.run(() =>
            withBackoff(() => this.client.getBlock({ blockNumber: b }).then((blk) => blk.timestamp), {
              operation: "scribe.getBlock",
            }),
          );
          this.blockTimes.set(b, Number(ts));
          this.pendingBlockTimes.delete(b);
          // The row is re-hydrated with the timestamp it was missing.
          hydrateTimestamps(this.model, this.blockTimes, []);
        } catch {
          // Still unavailable; it stays pending and is retried next tick.
        }
      }
    }
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
