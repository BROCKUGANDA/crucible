import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { TRIALS_ABI } from "@crucible/smith";
import {
  createPublicClient,
  encodeEventTopics,
  getAddress,
  hexToBytes,
  http,
  keccak256,
  type Abi,
  type AbiEvent,
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
import { canonicalOrder } from "./replica.js";
import { RpcThrottler, withBackoff, BreakerOpen, CircuitBreaker } from "@crucible/smith";

/**
 * Live tailing of one contract's logs, replayed into a read model.
 *
 * Ponder is the intended production indexer; this is a dependency-light tailer
 * that produces the identical read model, so the API and frontend work without a
 * Postgres instance and the demo runs with one process.
 *
 * The contract is a parameter (`source`), not a constant: the transport below is the same
 * sharded, bloom-checked, quiet-tail-proof, reorg-safe reader whichever escrow it points at.
 * The reducer is still the v1 escrow's — `TRIALS_SOURCE` is the only source wired to one today.
 */

/**
 * One contract's log surface: the address to read, the ABI the shapes come from, and the events
 * to accept.
 *
 * The Scribe was written against `CrucibleTrials` and carried all three as module constants, so a
 * second contract could only have been indexed by forking the file. Nothing in the transport —
 * sharded reads, the bloom cross-check, the quiet-tail proof, reorg replay — knows which contract
 * it is reading; these three fields are the whole of what does.
 */
export interface LogSource {
  /** The contract whose logs this transport reads. */
  address: Address;
  /** The ABI the event shapes are decoded from. */
  abi: Abi;
  /** Which of that ABI's events to accept. A list that matches none is a construction error. */
  eventNames: readonly string[];
}

/** The v1 escrow's events — the only contract this repository has indexed until now. */
export const TRIALS_EVENTS = [
  "TrialCreated",
  "AgentRegistered",
  "RunnerSet",
  "TrialClaimed",
  "RunSubmitted",
  "BreakFiled",
  "DisputeOpened",
  // The two seat votes. A dispute's `_disputes` mapping is private and neither
  // `disputeOf` nor `disputeVote` can enumerate WHO holds a commitment, so these logs are
  // the only source for "how many seats have committed" — the count an Argus seat must
  // wait for before revealing, per ADR-0004.
  "VoteCommitted",
  "VoteRevealed",
  "VerdictFinalized",
  "StakeWithdrawn",
  "Withdrawn",
  "IdentityLinked",
] as const;

/** The v1 escrow as a source. A caller spreads it and supplies the address. */
export const TRIALS_SOURCE = { abi: TRIALS_ABI, eventNames: TRIALS_EVENTS } as const;

export interface IndexerConfig {
  /** The contract to read, and which of its events to accept. */
  source: LogSource;
  /**
   * Accepted for callers that pass one chain config, and deliberately NOT indexed.
   *
   * The Scribe reads only the trials address. Alloy (tier and soulbound-lock) state is read
   * live by the API with a short TTL — `server.ts`'s `alloyState` — because it changes
   * rarely and a log projection of it would be a second source of truth for the same fact.
   * Nothing here consumes this field; it is optional so that a caller cannot be misled into
   * thinking its presence means alloy events are being projected.
   */
  alloyAddress?: Address;
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
   * Called with every batch of logs this transport reads, before the trials reducer sees them.
   *
   * The Scribe projects into `ReadModel`, which is the v1 escrow's shape. A caller that wants the
   * same transport for a different contract supplies a `source` and a reducer here. Optional: a
   * caller that only wants the trials model says nothing.
   */
  onEvents?: (events: EventLike[]) => void;
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
  const why = proof.detail ? ` (${proof.detail})` : "";
  return `a block between ${proof.cursor} and ${head} may hold an event; the index is re-reading it${why}`;
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
  /** true only when a read failed; a lagging but ticking index is not stalled */
  syncStalled: boolean;
  /**
   * Trials that settled before this index started listening, so their rows are
   * incomplete. Non-zero means the index is not reading the whole history —
   * a `FROM_BLOCK` that is too high, or a cursor file from a chain that was
   * rebuilt. It is counted because the alternative is a hall that quietly
   * omits trials that were paid out.
   */
  partialTrials: number;
  /**
   * The `timestamp` of the highest block this index has actually read, in chain seconds, or
   * `null` when no block has been read yet.
   *
   * It is published because a deadline in this system is a claim about `block.timestamp`, and a
   * browser cannot read the chain's clock without one. It is the highest block *read*, not the
   * head: on an idle instant-mining chain the two differ, and that is fine — the consumer takes
   * `max(headTimestamp + 1, wall clock)`, which is the rule the node itself uses to stamp the
   * next block. Never zero: a zero here would say the chain began in 1970, and every window
   * would read as long expired.
   */
  headTimestamp: number | null;
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
  /**
   * Highest block number this index has read a timestamp for, and that timestamp.
   *
   * Two scalars rather than a scan of `blockTimes`, because `blockTimes` is keyed by the blocks
   * that carried events and grows with the history; the newest reading is the only thing the
   * published clock needs.
   */
  private headRead: { number: bigint; timestamp: number } | null = null;
  /** Blocks whose timestamp could not be read, retried on the next tick. */
  private readonly pendingBlockTimes = new Set<bigint>();
  private running = false;
  private head: bigint | null = null;
  private syncError: string | null = null;
  /**
   * Whether the last tick stopped because a read FAILED, as opposed to merely being behind.
   *
   * `/health` used `syncError != null` for this, and the sentence is also set while the cursor is
   * legitimately walking a gap at 64 blocks a tick — so a cold index reported itself stalled for as
   * long as the backfill took, and the compose probe gave up on a service that was working. A
   * missing measurement and a slow one are different states, and only one of them is an error.
   */
  private syncStalled = false;
  /** The trip this process last reported, so an outage writes one line rather than one per tick. */
  private lastTripReportedAt: number | null = null;
  /** The incomplete-trial count last reported, so it is written once rather than every tick. */
  private reportedPartialTrials = 0;
  /** One ceiling on concurrent RPC calls for the whole indexer. */
  private readonly rpc = new RpcThrottler(8);
  /** The events this source accepts, resolved from its ABI once rather than per read. */
  private readonly events: AbiEvent[];
  /** Every topic0 this source would accept, for the block-bloom cross-check. */
  private readonly topic0s: `0x${string}`[];

  constructor(private readonly cfg: IndexerConfig) {
    this.events = cfg.source.abi.filter(
      (item): item is AbiEvent =>
        item.type === "event" && cfg.source.eventNames.includes(item.name),
    );
    /**
     * A name that matches nothing indexes nothing, and an index that accepts no event looks
     * exactly like a quiet chain from every caller's side. Refusing at construction is the only
     * place the difference can still be seen.
     */
    if (this.events.length === 0) {
      throw new Error(
        `indexer source ${cfg.source.address} accepts no event from its own ABI: ` +
          `[${cfg.source.eventNames.join(", ")}] matched none of its ${cfg.source.abi.length} entries.`,
      );
    }
    this.topic0s = this.events.map(
      (e) => encodeEventTopics({ abi: cfg.source.abi, eventName: e.name })[0] as `0x${string}`,
    );
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
      // Temp-then-rename, the same rule the juror's seat state follows. `writeFileSync` truncates
      // before it writes, so a death mid-write left a half-written cursor — and `loadCursor`'s
      // catch treats an unparseable cursor as no cursor, i.e. a silent full re-scan from
      // `fromBlock`. The old code wrote the real file in place and deleted a temp file nothing had
      // read, so the "written atomically" in the comment above was never true. `rename` is atomic
      // on one filesystem, and the pid keeps two processes from sharing a temp path — three
      // services already read the same `CRUSIBLE_CURSOR_FILE` name.
      const tmp = `${this.cfg.cursorFile}.${process.pid}.tmp`;
      writeFileSync(tmp, this.cursor.toString(), "utf8");
      renameSync(tmp, this.cfg.cursorFile);
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
      syncStalled: this.syncStalled,
      partialTrials: this.countPartialTrials(),
      headTimestamp: this.headRead?.timestamp ?? null,
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

    // Every tick, including the caught-up one that returns a few lines below.
    //
    // This used to live inside `recordBlockTimes`, which is called only when a batch has logs, so a
    // block whose `getBlock` failed once was retried only if some later batch happened to carry an
    // event — and a caught-up chain has no later batch at all. The pending read sat there while the
    // row kept a block number as its `createdAt`/`runAt`, and `breakWindowEndsAt` is
    // `runAt + breakWindow`, which is how a trial came to publish a deadline in 1970.
    await this.retryPendingBlockTimes();

    // The cursor is the NEXT block to read, so `head + 1` is the caught-up
    // state, not a reset. Treating it as one cleared the model and restarted
    // the backfill on every idle tick: the hall emptied, `/ready` flipped
    // between true and false, and the index never settled. Only a cursor
    // beyond `head + 1` can have come from a shorter chain.
    if (this.cursor > head) {
      if (this.cursor === head + 1n) {
        this.syncError = null;
        this.syncStalled = false;
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
      // A rebuilt chain shares nothing with the old one's clock. Carrying the previous head's
      // timestamp across the reset would publish a time the new chain has not reached — and on a
      // demo node that had been warped forward, that is a clock in the future that makes every
      // fresh window look already closed.
      this.headRead = null;
      this.pendingBlockTimes.clear();
      this.syncError = "the chain was reset; the index is rebuilding from the start block";
      this.syncStalled = false;
      this.saveCursor();
      return this.model;
    }

    const events = await this.fetchLogs(this.cursor, head);

    /**
     * A second reducer over the same transport. The Scribe still owns the trials model it has
     * always owned; this is how a caller projects the same logs into a different shape (the v2
     * arena) without forking the reader. Called with whatever the batch returned, including an
     * empty batch, so a caller can keep its own version counter honest.
     */
    this.cfg.onEvents?.(events);

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
      this.syncStalled = proof.stoppedBecause === "unreadable";
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
    this.syncStalled = proof.stoppedBecause === "unreadable";
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
        // Every block already paid for is a clock reading obtained for free. Recorded BEFORE the
        // bloom test, because a quiet head block is precisely the case in which nothing else in a
        // tick learns what time the chain thinks it is.
        this.noteHeadRead(b.number ?? block, Number(b.timestamp));

        const bloom = b.logsBloom;
        if (!bloom || bloom === "0x" || !this.topic0s.some((t) => bloomMayContain(bloom, t))) {
          continue;
        }
        // A block's own number is the authority, and it is null only for a
        // pending block, which a mined range never holds.
        const number = b.number ?? block;

        // The bloom says a log with one of our topic0s is in this block. It does NOT say
        // the log came from the contract we index, and treating the two as the same thing
        // wedges the cursor permanently.
        //
        // Reproduced on this repository's own demo: run `script/Demo.s.sol` a second time
        // against a live chain and it deploys a *second* `CrucibleTrials`. That contract
        // emits the same events with the same topic0s, so every block it touches matches
        // the bloom, `fetchLogs` (which filters on our address) finds nothing, the proof
        // stops on the same block, and `/health` sits at `ok:false` forever while the site
        // shows a frozen index. A redeploy, an old deployment still emitting, or a mock all
        // produce the same deadlock.
        //
        // So ask the block, without the address filter: if a same-signature log exists and
        // none of it is ours, this block is quiet for us and the walk continues. If the
        // node returns logs and one IS ours, the range read missed something and we stop.
        // If the node returns nothing at all while the bloom claims otherwise, the bloom
        // and the node disagree, which is exactly the truncation/pruning case this guard
        // exists for — stop.
        let verdict: "ours" | "foreign" | "disagrees";
        try {
          const logs = await this.rpc.run(() =>
            withBackoff(
              () => this.client.getLogs({ fromBlock: number, toBlock: number, events: this.events }),
              { operation: "scribe.getLogs" },
            ),
          );
          if (logs.length === 0) {
            verdict = "disagrees";
          } else {
            const ours = this.cfg.source.address.toLowerCase();
            verdict = logs.some((l) => l.address.toLowerCase() === ours) ? "ours" : "foreign";
          }
        } catch (err) {
          return {
            cursor: number,
            stoppedBecause: "unreadable",
            detail: err instanceof Error ? err.message : String(err),
          };
        }

        if (verdict !== "foreign") {
          return {
            cursor: number,
            stoppedBecause: "possible-event",
            detail:
              verdict === "ours"
                ? "the range read returned no logs for a block that holds one of ours"
                : "the block's bloom claims a log the node did not return",
          };
        }
        // A foreign same-signature log. Not ours, nothing to index here.
      }
      block = chunkEnd + 1n;
    }
    return { cursor: end + 1n, stoppedBecause: "quiet" };
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

    // One ordering rule, shared with every replica (`replica.ts`), rather than a second comparator
    // beside the first. Shards are read in parallel, so the merged array is in whatever order the
    // promises settled: without this, the fold would see the same chain as a different sequence on
    // every run, and two indexers of one chain would not converge.
    return canonicalOrder(groups.flat());
  }

  private async fetchLogsWindow(from: bigint, to: bigint): Promise<EventLike[]> {
    const logs = (await this.rpc.run(() =>
      withBackoff(
        () =>
          this.client.getLogs({
            address: this.cfg.source.address,
            events: this.events,
            fromBlock: from,
            toBlock: to,
          }),
        { operation: "scribe.getLogs" },
      ),
    )) as Log[];
    // The chain id travels with the log, because a log's identity is its chain *and* its position:
    // the digest the fold dedupes on has to differ between two chains that both have a height 100.
    // Spreading `toEventLike` straight into `map` would hand it the array index instead.
    return logs.map((log) => toEventLike(log, this.cfg.chain.id));
  }

  /**
   * Remember the newest block number we have read a timestamp for.
   *
   * Monotonic on purpose: ticks walk ranges in order and a retried read can name an older block,
   * so taking the max keeps the published clock from stepping backwards mid-sentence.
   */
  private noteHeadRead(blockNumber: bigint, timestamp: number): void {
    if (this.headRead !== null && blockNumber <= this.headRead.number) return;
    this.headRead = { number: blockNumber, timestamp };
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
            ).then((ts) => {
              const seconds = Number(ts);
              this.blockTimes.set(b, seconds);
              this.noteHeadRead(b, seconds);
            }),
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

  }

  /**
   * Retry the block timestamps that could not be read, and apply each one to the rows that name it.
   *
   * `hydrateTimestamps(model, blockTimes, [])` does nothing at all — an explicit empty list maps to
   * an empty target set — and that is what this call used to pass. The comment promised "the row is
   * re-hydrated with the timestamp it was missing"; the read succeeded, the seconds went into the
   * map, the map was discarded at the end of the next batch, and the row kept a block number as its
   * `createdAt`/`runAt`. Omitting the list means "every row", which is the only correct filter when
   * the input is "this block became readable again" rather than "these trials changed".
   */
  private async retryPendingBlockTimes(): Promise<void> {
    for (const b of [...this.pendingBlockTimes]) {
      try {
        const ts = await this.rpc.run(() =>
          withBackoff(() => this.client.getBlock({ blockNumber: b }).then((blk) => blk.timestamp), {
            operation: "scribe.getBlock",
          }),
        );
        this.blockTimes.set(b, Number(ts));
        this.noteHeadRead(b, Number(ts));
        this.pendingBlockTimes.delete(b);
        hydrateTimestamps(this.model, this.blockTimes);
        // Only this block's entry is dropped: `blockTimes` may also hold the current batch's
        // times, which `syncOnce` clears after applying them.
        this.blockTimes.delete(b);
      } catch {
        // Still unavailable; it stays pending and is retried on the next tick.
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
 *
 * `chainId` is the second argument rather than a read of the log because a node's log does not carry
 * one — the reader knows it, and only the reader can say which chain it just asked. A caller that
 * cannot say leaves it off, and the fold treats the event as chain-unscoped instead of guessing.
 */
export function toEventLike(log: Log, chainId?: number): EventLike {
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
    // Only when the reader actually has a chain in hand. A fixture that invents one would make the
    // log digest describe a chain nobody read.
    ...(chainId === undefined ? {} : { chainId }),
  };
}
