/**
 * The replay projector (v2 bible §16: "replays read lines back instead of regenerating them").
 *
 * A trial's own logs, read back from the node, folded into frames by `@crucible/frame`. Nothing
 * is stored twice and nothing is invented: the money in a frame is the number the contract
 * emitted, and the range that was searched is reported so a reader can tell "this trial has two
 * beats" from "this node has pruned the blocks where the rest happened".
 *
 * The API holds no chain key (ADR-0006). This route only reads.
 */

import { Hono } from "hono";
import { decodeEventLog, encodeEventTopics, toHex } from "viem";

import { TRIALS_ABI } from "@crucible/smith";
import { num, reduceReplay, toChainLog, type ChainLogWire } from "@crucible/frame";

/** The beats a replay can show. An event outside this list is not a frame. */
export const REPLAY_EVENTS = [
  "TrialCreated",
  "TrialClaimed",
  "RunSubmitted",
  "BreakFiled",
  "DisputeOpened",
  "VoteCommitted",
  "VoteRevealed",
  "VerdictFinalized",
] as const;

const TOPICS: `0x${string}`[] = REPLAY_EVENTS.map(
  (name) => encodeEventTopics({ abi: TRIALS_ABI, eventName: name })[0] as `0x${string}`,
);

/** A log as a node answers it: `data` and `topics`, nothing decoded. */
interface RawLog {
  blockNumber: bigint;
  transactionHash: string;
  logIndex: number;
  data: `0x${string}`;
  topics: readonly `0x${string}`[];
}

/** What the node is asked for. `getLogs` is the only read this route makes. */
export interface LogReader {
  getLogs: (args: {
    address: `0x${string}`;
    topics: [`0x${string}`[], `0x${string}`];
    fromBlock: bigint;
    toBlock: bigint;
  }) => Promise<RawLog[]>;
  getBlockNumber: () => Promise<bigint>;
}

export interface ReplaySourceResult {
  logs: ChainLogWire[];
  /** the inclusive block range that was actually searched */
  range: { fromBlock: number; toBlock: number };
  /**
   * Logs whose topics this ABI could not name. Counted and reported, never dropped quietly.
   */
  skipped: number;
  /**
   * Logs that decoded fine but are not replay beats — an admin setting, a receipt mint, a
   * neighbour trial's beat. Non-zero is the normal case: the node is asked for the contract's
   * whole log set (see the topics note below), and only some of it is a story.
   */
  otherEvents: number;
}

/**
 * How far back a replay looks, in blocks. A bounded window rather than "from genesis", because
 * one `getLogs` over a long chain is a request an unauthenticated visitor can make many times
 * a minute. The default covers a demo chain's whole life; a real deployment raises it or indexes
 * the logs it wants to keep.
 */
export const DEFAULT_REPLAY_WINDOW = 200_000n;

export function makeReplaySource(args: {
  reader: LogReader;
  address: `0x${string}`;
  windowBlocks?: bigint;
}): (trialId: number) => Promise<ReplaySourceResult> {
  const windowBlocks = args.windowBlocks ?? DEFAULT_REPLAY_WINDOW;
  const wanted = new Set<string>(REPLAY_EVENTS);
  return async (trialId: number) => {
    const head = await args.reader.getBlockNumber();
    const fromBlock = head > windowBlocks ? head - windowBlocks : 0n;
    const logs = await args.reader.getLogs({
      address: args.address,
      // A hint, not a dependency. Measured on the deployment's own node on 2026-10-24: Anvil
      // answered all 56 logs for a one-topic filter, so the filter cannot be trusted to narrow
      // anything. What narrows is the decode plus the trial id below, and a node that DOES
      // honour the topics simply answers less.
      topics: [TOPICS, toHex(BigInt(trialId), { size: 32 })],
      fromBlock,
      toBlock: head,
    });

    const out: ChainLogWire[] = [];
    let skipped = 0;
    let otherEvents = 0;
    for (const log of logs) {
      let eventName: string;
      let decoded: Record<string, unknown>;
      try {
        // Decoded here rather than asked of the client: `getLogs({ abi })` on this node returns
        // `eventName: undefined` and `args: undefined` on every log, so a projector that trusts
        // the transport to decode renders an empty replay and calls it "no history".
        const d = decodeEventLog({
          abi: TRIALS_ABI,
          data: log.data,
          topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
        });
        eventName = d.eventName;
        decoded = (d.args ?? {}) as Record<string, unknown>;
      } catch {
        skipped += 1;
        continue;
      }
      if (!wanted.has(eventName)) {
        otherEvents += 1;
        continue;
      }
      // The id is indexed first on every one of these events, and it is the filter that actually
      // holds — the node's own topic filter does not.
      if (num(decoded.id) !== trialId) {
        otherEvents += 1;
        continue;
      }
      out.push({
        blockNumber: log.blockNumber.toString(),
        transactionHash: log.transactionHash,
        logIndex: log.logIndex,
        address: args.address,
        eventName,
        args: wireArgs(decoded),
      });
    }

    return {
      range: { fromBlock: Number(fromBlock), toBlock: Number(head) },
      logs: out,
      skipped,
      otherEvents,
    };
  };
}

/** Bigints leave as decimal strings; everything else is already JSON-safe. */
function wireArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) out[key] = typeof value === "bigint" ? value.toString() : value;
  return out;
}

/**
 * `/replay/:id`. Mounted only when a source exists; an unconfigured deployment answers 501
 * rather than rendering an empty stage that looks like a trial with no history.
 */
export function createReplayRoutes(
  source: ((trialId: number) => Promise<ReplaySourceResult>) | null | undefined,
  proofSource?: { chain: string; chainId: number; trialsAddress: string },
  /** Whether the index knows this trial. Absent means the route cannot tell, and it says so. */
  knowsTrial?: (trialId: number) => boolean,
): Hono {
  const app = new Hono();

  app.get("/:id", async (c) => {
    if (!source) return c.json({ error: "this deployment does not read replay logs" }, 501);

    const raw = c.req.param("id");
    if (!/^\d+$/.test(raw)) {
      return c.json({ error: "trial id must be a positive integer" }, 400);
    }
    const trialId = Number(raw);
    if (!Number.isSafeInteger(trialId) || trialId <= 0) {
      return c.json({ error: "trial id must be a positive integer" }, 400);
    }

    let result: ReplaySourceResult;
    try {
      result = await source(trialId);
    } catch (err) {
      // The node failing is a different fact from the trial having no history, and the HTTP
      // code has to say which one or a reader cannot tell a dead RPC from a dead trial.
      return c.json(
        { error: `could not read replay logs: ${(err as Error).message}` },
        502,
      );
    }

    const replay = reduceReplay(
      trialId,
      result.logs.map(toChainLog),
    );

    if (replay.frames.length === 0 && knowsTrial && !knowsTrial(trialId)) {
      // Two different empties. A trial the index has never heard of and that left no logs is a
      // trial that does not exist; a trial the index knows with no logs in range is history the
      // node has dropped. Only the first is a 404.
      return c.json({ error: `trial ${trialId} is not in the index and left no replay logs` }, 404);
    }

    return c.json({
      data: replay,
      meta: {
        trialId,
        logsFound: result.logs.length,
        logsUndecoded: result.skipped,
        logsOtherEvents: result.otherEvents,
        range: result.range,
        /**
         * No `TrialCreated` inside the window. Either the trial predates it, or the node
         * pruned those blocks — the reader decides which by widening the window, because this
         * projection cannot tell the two apart.
         */
        beforeWindow: replay.incomplete && result.range.fromBlock > 0,
        source: proofSource ?? null,
      },
    });
  });

  return app;
}
