import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { keccak256, hexToBytes, toHex, decodeAbiParameters, encodeAbiParameters, encodeEventTopics, parseEventLogs } from "viem";
import { TRIALS_ABI } from "@crucible/smith";
import { bloomMayContain, Scribe, toEventLike } from "../src/scribe.js";
import { foundry } from "viem/chains";
import { applyEvent, disputeState, emptyModel, replay } from "../src/model.js";

/**
 * `toEventLike` is the only place a chain log becomes a read-model event, and it is the
 * only seam the replay tests never touched: they hand-build `args`, so a decoder that
 * read the wrong field still produced green tests and an empty hall.
 *
 * The log under test is encoded from the ABI and decoded through `parseEventLogs` — the
 * same call `getLogs` makes — so the shape is viem's actual output rather than a guess
 * about it.
 */

const TRIALS = "0x4444444444444444444444444444444444444444" as const;

type AbiEvent = Extract<(typeof TRIALS_ABI)[number], { type: "event" }>;

function abiEvent(name: string): AbiEvent {
  const item = TRIALS_ABI.find((i) => i.type === "event" && i.name === name) as AbiEvent | undefined;
  if (!item) throw new Error(`${name} is not in TRIALS_ABI`);
  return item;
}

/** A live-shaped log: `args` decoded from topics + data, `data` still the raw hex. */
function liveLog(eventName: string, values: Record<string, unknown>) {
  const item = abiEvent(eventName);
  const indexed = item.inputs.filter((i) => i.indexed);
  const plain = item.inputs.filter((i) => !i.indexed);

  const topics = encodeEventTopics({
    abi: TRIALS_ABI,
    eventName,
    args: Object.fromEntries(indexed.map((i) => [i.name, values[i.name]])),
  } as never) as `0x${string}`[];

  const data = encodeAbiParameters(
    plain.map(({ name: _n, indexed: _i, ...rest }) => rest),
    plain.map((i) => values[i.name]) as never,
  );

  const decoded = parseEventLogs({
    abi: TRIALS_ABI,
    events: [item],
    logs: [{ address: TRIALS, data, topics, blockNumber: 1_234n, transactionHash: `0x${"ab".repeat(32)}`, logIndex: 7 }],
  })[0] as never as { args: Record<string, unknown> };

  return {
    address: TRIALS,
    blockNumber: 1_234n,
    transactionHash: `0x${"ab".repeat(32)}`,
    logIndex: 7,
    eventName,
    args: decoded.args,
    data,
    topics,
  };
}

/**
 * A JSON-RPC node that answers `eth_getLogs` with nothing while its blocks say otherwise —
 * the exact shape of a truncated, pruned, or lying RPC response. `quietBlocks` flips the
 * blocks' logsBloom to empty, which is what a genuinely idle chain looks like from here.
 *
 * The head block and each block's bloom are configurable, because the two cases that
 * matter are both about ranges rather than about a single window: a chain whose events
 * are far apart, and a node that answers for one range and goes quiet for the rest.
 */
async function lyingNode(opts: {
  logs: unknown[];
  quietBlocks?: boolean;
  /** the head the node reports */
  head?: number;
  /** whether the bloom of a given block says it may hold a Crucible event */
  bloomHasEvent?: (blockNumber: number) => boolean;
  /**
   * Whether the node refuses JSON-RPC batches, the way anvil does.
   *
   * anvil is the chain this project deploys, and it answers a batched
   * request with an error. A client that batches therefore fails against the
   * chain it was written for — which is exactly what happened, and the
   * symptom was an index that emptied itself with nothing in the log but a
   * transport error.
   */
  refuseBatches?: boolean;
  /**
   * Whether the node refuses to read a given block.
   *
   * A pruned block, a node that is still catching up, a proxy that drops a
   * request — the block read fails while the head read succeeds, and the
   * indexer has to decide what that means for the cursor.
   */
  failBlockRead?: (blockNumber: number) => boolean;
  /**
   * A second contract emitting the SAME events, from a different address, from this block
   * onward.
   *
   * This is not a contrived shape: running `script/Demo.s.sol` twice against one chain
   * deploys a second `CrucibleTrials`, as does any redeploy. Its logs share every topic0
   * with the contract we index, so they light up the bloom while an address-filtered
   * `getLogs` legitimately returns nothing. When the node answers only the unfiltered
   * query, that is exactly what the indexer sees.
   */
  foreignFrom?: number;
}): Promise<{
  url: string;
  address: `0x${string}`;
  trialTopic: `0x${string}`;
  close: () => void;
}> {
  const trialTopic = encodeEventTopics({ abi: TRIALS_ABI, eventName: "TrialCreated" })[0] as `0x${string}`;
  const digest = hexToBytes(keccak256(trialTopic));
  const bloomFor = (hasEvent: boolean) => {
    const bloom = new Uint8Array(256);
    if (hasEvent) {
      for (let i = 0; i < 3; i++) {
        const bit = (((digest[i * 2] ?? 0) << 8) | (digest[i * 2 + 1] ?? 0)) & 0x7ff;
        bloom[255 - (bit >> 3)] |= 1 << (bit & 7);
      }
    }
    return toHex(bloom);
  };

  const head = opts.head ?? 6;
  const hasEvent = (n: number) =>
    opts.bloomHasEvent ? opts.bloomHasEvent(n) : opts.quietBlocks !== true;

  const address = "0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0" as `0x${string}`;
  const blockFor = (n: number) => ({
    number: toHex(n),
    hash: `0x${"11".repeat(32)}`,
    parentHash: `0x${"22".repeat(32)}`,
    nonce: "0x0",
    sha3Uncles: `0x${"33".repeat(32)}`,
    logsBloom: bloomFor(hasEvent(n)),
    transactionsRoot: `0x${"44".repeat(32)}`,
    stateRoot: `0x${"55".repeat(32)}`,
    receiptsRoot: `0x${"66".repeat(32)}`,
    miner: `0x${"00".repeat(20)}`,
    difficulty: "0x0",
    totalDifficulty: "0x0",
    extraData: "0x",
    gasLimit: "0x1c9c380",
    gasUsed: "0x0",
    timestamp: "0x67000000",
    transactions: [],
    uncles: [],
    baseFeePerGas: "0x0",
  });

  const answer = (method: string, params: unknown[]): unknown => {
    if (method === "eth_blockNumber") return toHex(head);
    if (method === "eth_getLogs") {
      const filter = params?.[0] as { address?: unknown; fromBlock?: string } | undefined;
      if (opts.foreignFrom !== undefined && filter?.address === undefined) {
        // The unfiltered probe. A log with our topic0 exists, and it belongs to the other
        // contract — the node is telling the truth and so is the bloom.
        const n = Number(filter?.fromBlock ? BigInt(filter.fromBlock) : 0n);
        if (n >= opts.foreignFrom) {
          return [
            {
              address: "0xa513e6e4b8f2a923d98304ec87f64353c4d5c853",
              topics: [trialTopic],
              data: "0x",
              blockNumber: toHex(n),
              transactionHash: `0x${"77".repeat(32)}`,
              transactionIndex: "0x0",
              blockHash: `0x${"11".repeat(32)}`,
              logIndex: "0x0",
              removed: false,
            },
          ];
        }
      }
      // The address-filtered read — what the indexer actually asks for. Nothing of ours.
      return opts.logs;
    }
    if (method === "eth_chainId") return "0x7a69";
    if (method === "eth_getBlock" || method === "eth_getBlockByNumber") {
      // viem sends `eth_getBlockByNumber` with `params: ["0x5", false]`.
      // A hand-written node often uses `eth_getBlock` with
      // `params: [{ blockNumber: "0x5" }]`. Both shapes appear in the wild,
      // and the test is about the indexer's behaviour rather than about one
      // client's parameter style.
      const first = params?.[0];
      const raw =
        typeof first === "object" && first !== null
          ? (first as { blockNumber?: string }).blockNumber
          : (first as string | undefined);
      const n = Number(raw ? BigInt(raw) : 0n);
      return blockFor(n);
    }
    return blockFor(0);
  };

  /** The block a call was for, or null when the call was not a block read. */
  const blockOf = (method: string, params: unknown[]): number | null => {
    if (method !== "eth_getBlock" && method !== "eth_getBlockByNumber") return null;
    const first = params?.[0];
    const raw =
      typeof first === "object" && first !== null
        ? (first as { blockNumber?: string }).blockNumber
        : (first as string | undefined);
    return Number(raw ? BigInt(raw) : 0n);
  };

  /** One JSON-RPC answer: a result, or an error for a block the node refuses. */
  const replyFor = (call: { id: number; method: string; params?: unknown[] }) => {
    const block = blockOf(call.method, call.params ?? []);
    if (block !== null && opts.failBlockRead?.(block)) {
      return {
        jsonrpc: "2.0",
        id: call.id,
        error: { code: -32000, message: `block ${block} is unavailable` },
      };
    }
    return { jsonrpc: "2.0", id: call.id, result: answer(call.method, call.params ?? []) };
  };

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as
        | { id: number; method: string; params?: unknown[] }
        | { id: number; method: string; params?: unknown[] }[];
      // A JSON-RPC batch is an array in and an array out. Not every node
      // speaks it — anvil, the chain this project deploys, answers a batch
      // with an error — so the mock can refuse batches the way anvil does.
      // The indexer must work on both.
      if (Array.isArray(parsed)) {
        if (opts.refuseBatches) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32600, message: "batch requests are not supported" },
            }),
          );
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify(
            parsed.map((call) => replyFor(call)),
          ),
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(replyFor(parsed)));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    address,
    trialTopic,
    close: () => server.close(),
  };
}

describe("toEventLike", () => {
  it("carries the decoded values, not the raw hex", () => {
    const e = toEventLike(
      liveLog("VerdictFinalized", { id: 7n, verdict: 1, agentPayout: 950_000_000_000_000_000n }) as never,
    );

    expect(e.eventName).toBe("VerdictFinalized");
    expect(e.args.id).toBe(7n);
    expect(e.args.verdict).toBe(1);
    expect(e.args.agentPayout).toBe(950_000_000_000_000_000n);
  });

  it("keeps provenance the hall proof depends on", () => {
    const e = toEventLike(
      liveLog("IdentityLinked", { agentId: 3n, identityAgentId: 4_242n }) as never,
    );

    expect(e.transactionHash).toBe(`0x${"ab".repeat(32)}`);
    expect(e.blockNumber).toBe(1_234n);
    expect(e.address).toBe(TRIALS);
    expect(e.logIndex).toBe(7);
  });

  it("settles a trial through the live decoding path", () => {
    const created = toEventLike(
      liveLog("TrialCreated", {
        id: 1n,
        sponsor: "0x1111111111111111111111111111111111111111",
        specCID: `0x${"11".repeat(32)}`,
        testsCID: `0x${"22".repeat(32)}`,
        reward: 1_000_000_000_000_000_000n,
        bond: 0n,
        deadline: 1_800_000_000,
        breakWindow: 43_200,
      }) as never,
    );

    let model = applyEvent(emptyModel(), created);
    model = applyEvent(
      model,
      toEventLike(
        liveLog("AgentRegistered", {
          agentId: 1n,
          operator: "0x2222222222222222222222222222222222222222",
          metadataURI: "ipfs://manifest",
          runner: "0x5555555555555555555555555555555555555555",
          stake: 1_000_000_000_000_000_000n,
        }) as never,
      ),
    );
    model = applyEvent(
      model,
      toEventLike(
        liveLog("TrialClaimed", {
          id: 1n,
          agentId: 1n,
          bond: 0n,
        }) as never,
      ),
    );
    model = applyEvent(
      model,
      toEventLike(liveLog("VerdictFinalized", { id: 1n, verdict: 1, agentPayout: 1n }) as never),
    );

    const trial = model.trials.get(1);
    expect(trial?.status).toBe("settled");
    expect(trial?.verdict).toBe("paid");
    expect(model.agents.get(1)?.wins).toBe(1);
    expect([...model.agents.get(1)!.settlements][0].trialId).toBe(1);
  });

  it("survives a log the decoder could not resolve", () => {
    const e = toEventLike({
      address: TRIALS,
      blockNumber: null,
      transactionHash: null,
      logIndex: 0,
      data: "0x",
      topics: [],
    } as never);

    expect(e.eventName).toBe("");
    expect(e.args).toEqual({});
    expect(e.blockNumber).toBe(0n);
    expect(e.transactionHash).toBe("");
  });
});

/**
 * The cursor must not walk across a range it got no answer for.
 *
 * `getLogs` replying `[]` is the same bytes whether the chain is quiet or the node is
 * truncating, pruned, or having a bad afternoon, and the old code advanced the cursor either
 * way: one such reply skipped the whole history permanently and `/hall` answered `[]` with a
 * 200. These drive a Scribe against a node that lies by omission and check it notices.
 */
describe("bloom cross-check on a quiet window", () => {
  it("reads a real log bloom as possibly containing the event, and an empty one as not", () => {
    const topic = encodeEventTopics({ abi: TRIALS_ABI, eventName: "TrialCreated" })[0] as `0x${string}`;
    // A bloom built the way a client would test it: three 11-bit positions from keccak(topic).
    const digest = keccak256(topic);
    const bytes = hexToBytes(digest);
    const bloom = new Uint8Array(256);
    for (let i = 0; i < 3; i++) {
      const bit = (((bytes[i * 2] ?? 0) << 8) | (bytes[i * 2 + 1] ?? 0)) & 0x7ff;
      bloom[255 - (bit >> 3)] |= 1 << (bit & 7);
    }
    expect(bloomMayContain(toHex(bloom), topic)).toBe(true);
    expect(bloomMayContain(`0x${"00".repeat(256)}`, topic)).toBe(false);
  });

  it("refuses to advance the cursor when the blocks say there was something to find", async () => {
    const node = await lyingNode({ logs: [] });
    const scribe = new Scribe({
      trialsAddress: node.address,
      alloyAddress: node.address,
      chain: foundry,
      rpcUrl: node.url,
      fromBlock: 0n,
    });

    const before = scribe.status.indexedTo;
    await scribe.sync();
    const after = scribe.status.indexedTo;

    expect(node.trialTopic).toBeTruthy();
    expect(after).toBe(before);
    expect(scribe.status.syncError).toContain("may hold an event");
    expect(scribe.state.trials.size).toBe(0);
    node.close();
  });

  it("does advance when every block in the window says nothing was there", async () => {
    const node = await lyingNode({ logs: [], quietBlocks: true });
    const scribe = new Scribe({
      trialsAddress: node.address,
      alloyAddress: node.address,
      chain: foundry,
      rpcUrl: node.url,
      fromBlock: 0n,
    });

    await scribe.sync();
    expect(scribe.status.indexedTo).toBe(7n);
    expect(scribe.status.syncError).toBeNull();
    node.close();
  });

  /**
   * The bug this covers: a quiet window WIDER than the bloom probe's chunk.
   *
   * The old code refused to advance across a window wider than 64 blocks, so
   * the first gap longer than that froze the index permanently — the cursor
   * could not move, the sync error stayed set, `/health` answered 503, and
   * the container was marked unhealthy. On any real chain the events are far
   * apart, so this was not an edge case: it was the normal case.
   *
   * The cursor now advances by however much was proved, and a long stretch is
   * proved over several ticks. It never stops.
   */
  /**
   * A bloom hit is not proof the log is OURS.
   *
   * Reproduced live before it was fixed: running `script/Demo.s.sol` a second time against
   * a running chain deploys a second `CrucibleTrials`. That contract emits the same events
   * with the same topic0s from a different address, so the block's bloom matches while the
   * address-filtered `getLogs` correctly returns nothing. The proof stopped on that block,
   * the next tick re-read it, and `/health` sat at `ok:false` with `indexedTo` pinned while
   * the site showed a frozen index — for as long as the process lived.
   *
   * The block is quiet for an indexer that watches one address, and the walk must cross it.
   */
  it("crosses a block whose matching log belongs to another contract", async () => {
    const node = await lyingNode({
      logs: [],
      head: 8,
      bloomHasEvent: (n) => n >= 3,
      foreignFrom: 3,
    });
    const scribe = new Scribe({
      trialsAddress: node.address,
      alloyAddress: node.address,
      chain: foundry,
      rpcUrl: node.url,
      fromBlock: 0n,
    });

    await scribe.sync();

    expect(scribe.status.syncError, "a foreign same-signature event is not our event").toBeNull();
    expect(scribe.status.indexedTo).toBe(9n);
    // Nothing was invented: the foreign log was never projected into the model.
    expect(scribe.state.trials.size).toBe(0);
    node.close();
  });

  it("crosses a quiet window far wider than the probe chunk", async () => {
    const node = await lyingNode({ logs: [], quietBlocks: true, head: 200 });
    const scribe = new Scribe({
      trialsAddress: node.address,
      alloyAddress: node.address,
      chain: foundry,
      rpcUrl: node.url,
      fromBlock: 0n,
    });

    // One tick proves what it can; the index is further along than before.
    await scribe.sync();
    const afterOneTick = scribe.status.indexedTo;
    expect(afterOneTick).toBeGreaterThan(0n);

    // And it keeps going: the cursor reaches the head, across ticks.
    for (let i = 0; i < 10 && scribe.status.indexedTo <= 200n; i++) {
      await scribe.sync();
    }
    expect(scribe.status.indexedTo).toBe(201n);
    expect(scribe.status.syncError).toBeNull();
    node.close();
  });

  /**
   * The chain this project actually deploys.
   *
   * anvil answers a JSON-RPC batch with an error. A client that batches its
   * reads therefore fails against the chain it was written for, and the
   * failure is not a loud one: the proof walk threw, the tick threw, and the
   * index — which had just been rebuilt after a chain reset — emptied itself
   * and stayed empty, with the site still answering 200 and the hall
   * answering [].
   *
   * So the indexer must work on a node that refuses batches, which is the
   * node this project runs.
   */
  it("indexes on a node that refuses JSON-RPC batches", async () => {
    const node = await lyingNode({ logs: [], quietBlocks: true, head: 12, refuseBatches: true });
    const scribe = new Scribe({
      trialsAddress: node.address,
      alloyAddress: node.address,
      chain: foundry,
      rpcUrl: node.url,
      fromBlock: 0n,
    });

    await scribe.sync();

    expect(scribe.status.indexedTo).toBe(13n);
    expect(scribe.status.syncError).toBeNull();
    node.close();
  });

  /**
   * A block that cannot be read stops the cursor there — and stops nothing
   * else.
   *
   * The alternative was to let the read failure throw out of the tick, which
   * meant the whole sync failed, the model was never rebuilt, and one
   * unreadable block emptied the hall. The indexer's answer to "I cannot
   * read a block" must not be "throw away everything I already know".
   */
  it("stops at an unreadable block without losing what it had", async () => {
    // The node serves one trial at block 1 and refuses to read block 3. The log
    // is shaped the way a node actually returns one — hex quantities, not the
    // decoded values — because that is what `JSON.stringify` has to survive.
    const { data, topics, transactionHash } = liveLog("TrialCreated", {
      id: 1n,
      sponsor: "0x1111111111111111111111111111111111111111",
      specCID: `0x${"11".repeat(32)}`,
      testsCID: `0x${"22".repeat(32)}`,
      reward: 1_000_000_000_000_000_000n,
      bond: 0n,
      deadline: 1_800_000_000,
      breakWindow: 43_200,
    });
    const node = await lyingNode({
      logs: [
        {
          address: "0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0",
          blockNumber: "0x1",
          transactionHash,
          logIndex: "0x7",
          removed: false,
          data,
          topics,
        },
      ],
      quietBlocks: true,
      head: 6,
      failBlockRead: (n) => n === 3,
    });
    const scribe = new Scribe({
      trialsAddress: node.address,
      alloyAddress: node.address,
      chain: foundry,
      rpcUrl: node.url,
      fromBlock: 0n,
    });

    await scribe.sync();

    // The cursor stops where the unreadable block begins rather than crossing
    // it: block 2 is the first block after the last event, and the read of
    // block 3 inside that chunk failed.
    expect(scribe.status.indexedTo).toBe(2n);
    // What it already knew is still there. This is the whole point: the answer
    // to "I cannot read a block" is not "throw away the index".
    expect(scribe.state.trials.size).toBe(1);
    // And the reason is published, because a stopped index with no reason is
    // the silent outage this path exists to avoid.
    expect(scribe.status.syncError).toMatch(/could not be read/i);
    node.close();
  });

  /**
   * A timestamp that could not be read is repaired later, on a tick with no events.
   *
   * This is the half the audit found missing in both directions. `recordBlockTimes` recorded the
   * block as pending and `hydrateTimestamps(model, blockTimes, [])` was then called with an explicit
   * empty list, which maps to an empty target set — the read succeeded, the seconds went into the
   * map, and no row was touched. And the retry lived inside the events branch, so a caught-up chain
   * — the only kind that has a pending block and nothing else happening — never ran it.
   *
   * The observable consequence is not cosmetic: `breakWindowEndsAt` is `runAt + breakWindow`, so a
   * row left holding a block number publishes a deadline in 1970, and the first sync here is the
   * shape that produces it.
   */
  it("repairs a row whose block was unreadable, on a later tick that carries no events", async () => {
    const { data, topics, transactionHash } = liveLog("TrialCreated", {
      id: 1n,
      sponsor: "0x1111111111111111111111111111111111111111",
      specCID: `0x${"11".repeat(32)}`,
      testsCID: `0x${"22".repeat(32)}`,
      reward: 1_000_000_000_000_000_000n,
      bond: 0n,
      deadline: 1_800_000_000,
      breakWindow: 43_200,
    });
    // Mutable on purpose: the first tick refuses block 1, the second serves it.
    const unreadable = new Set([1]);
    const node = await lyingNode({
      logs: [
        {
          address: "0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0",
          blockNumber: "0x1",
          transactionHash,
          logIndex: "0x7",
          removed: false,
          data,
          topics,
        },
      ],
      quietBlocks: true,
      head: 6,
      failBlockRead: (n) => unreadable.has(n),
    });
    const scribe = new Scribe({
      trialsAddress: node.address,
      alloyAddress: node.address,
      chain: foundry,
      rpcUrl: node.url,
      fromBlock: 0n,
    });

    await scribe.sync();
    // The trial exists, but its `createdAt` is the block NUMBER: the node refused the block and
    // there is nothing else it could honestly be.
    expect(scribe.state.trials.get(1)?.createdAt).toBe(1);

    // The node recovers, and the chain stays quiet: this tick sees no events at all, so only the
    // pending-timestamp retry can be what repairs the row.
    unreadable.clear();
    await scribe.sync();
    expect(scribe.state.trials.get(1)?.createdAt).toBe(0x67000000);
    node.close();
  });

  /**
   * The other half: a response that was quietly cut off.
   *
   * `getLogs` cannot tell you that it gave you less than you asked for. The
   * old code advanced to `head + 1` on the strength of a non-empty array, so
   * a truncated response lost the tail of the chain permanently — the same
   * class of loss the empty case was guarded against, in the branch that was
   * not.
   *
   * Now the cursor stops at the first block whose bloom says an event might
   * be in it, so the next tick re-reads that range and picks up what was
   * dropped.
   */
  it("does not advance past a block whose bloom says an event was dropped", async () => {
    // Blocks 0-4 are quiet. Block 5 claims to hold a Crucible event that the
    // logs answer did not include — a truncated response.
    const node = await lyingNode({
      logs: [],
      head: 10,
      bloomHasEvent: (n) => n === 5,
    });
    const scribe = new Scribe({
      trialsAddress: node.address,
      alloyAddress: node.address,
      chain: foundry,
      rpcUrl: node.url,
      fromBlock: 0n,
    });

    await scribe.sync();

    // The cursor stops AT the suspicious block, not past it.
    expect(scribe.status.indexedTo).toBe(5n);
    expect(scribe.status.syncError).toContain("may hold an event");
    node.close();
  });

  /**
   * A chain that was reset leaves the cursor above the head.
   *
   * The cursor file survives a restart, so after an anvil reset the indexer
   * returned the model it had and never re-read anything — while `/ready`
   * computed a lag of zero, because the cursor was above the head. The API
   * reported healthy while serving a frozen pre-reset index.
   */
  it("rebuilds when the chain is reset under it", async () => {
    const node = await lyingNode({ logs: [], quietBlocks: true, head: 3 });
    const scribe = new Scribe({
      trialsAddress: node.address,
      alloyAddress: node.address,
      chain: foundry,
      rpcUrl: node.url,
      fromBlock: 0n,
    });

    await scribe.sync();
    expect(scribe.status.indexedTo).toBe(4n);

    // The chain comes back shorter. The indexer has to notice and rebuild.
    const shorter = await lyingNode({ logs: [], quietBlocks: true, head: 1 });
    const reset = new Scribe({
      trialsAddress: shorter.address,
      alloyAddress: shorter.address,
      chain: foundry,
      rpcUrl: shorter.url,
      fromBlock: 0n,
    });
    reset.cursor = 50n; // a cursor left over from the longer chain
    await reset.sync();

    expect(reset.status.syncError).toContain("reset");
    expect(reset.status.indexedTo).toBeLessThanOrEqual(2n);
    node.close();
    shorter.close();
  });

  /**
   * A caught-up index is not a reset.
   *
   * The cursor names the next block to read, so after indexing through the head it is
   * `head + 1`. The reset check used `cursor > head`, which matched that state and
   * cleared the model on every idle tick — the hall emptied and refilled forever.
   */
  it("keeps its model when the cursor is simply one past the head", async () => {
    const node = await lyingNode({ logs: [], quietBlocks: true, head: 3 });
    const scribe = new Scribe({
      trialsAddress: node.address,
      alloyAddress: node.address,
      chain: foundry,
      rpcUrl: node.url,
      fromBlock: 0n,
    });

    await scribe.sync();
    expect(scribe.status.indexedTo).toBe(4n);
    expect(scribe.status.syncError).toBeNull();

    // The same head, one tick later. This used to be read as a chain reset,
    // which cleared the model and restarted the backfill every idle tick.
    await scribe.sync();
    expect(scribe.status.indexedTo).toBe(4n);
    expect(scribe.status.syncError).toBeNull();
    node.close();
  });

  /**
   * The clock a browser anchors chain deadlines on.
   *
   * The contract enforces `block.timestamp`, and this deployment warps that away from wall time
   * on purpose, so a client with only the API's `now` can show a window closing early or late.
   * The indexer already reads block bodies to prove a quiet range holds nothing, and it must
   * publish what it learned there rather than make every visitor ask the node.
   */
  it("publishes no chain clock before it has read a block", async () => {
    const node = await lyingNode({ logs: [], quietBlocks: true, head: 3 });
    const scribe = new Scribe({
      trialsAddress: node.address,
      alloyAddress: node.address,
      chain: foundry,
      rpcUrl: node.url,
      fromBlock: 0n,
    });

    // Null, not zero. Zero is 1970, and a countdown handed 1970 reports every deadline as past.
    expect(scribe.status.headTimestamp).toBeNull();
    node.close();
  });

  it("publishes the timestamp of the block it read, taken while proving the range quiet", async () => {
    const node = await lyingNode({ logs: [], quietBlocks: true, head: 3 });
    const scribe = new Scribe({
      trialsAddress: node.address,
      alloyAddress: node.address,
      chain: foundry,
      rpcUrl: node.url,
      fromBlock: 0n,
    });

    await scribe.sync();

    // The fixture stamps every block 0x67000000. The point is that a chain with no events at all
    // still yields a clock: a walk that discards the timestamps it already paid for is the bug.
    expect(scribe.status.headTimestamp).toBe(Number(0x67000000n));
    node.close();
  });
});

/**
 * The two seat votes, driven through the decoding path a live chain actually uses.
 *
 * A seat's reveal gate is "at least `ARGUS_THRESHOLD` seats have committed", and the only
 * witness to that is the `VoteCommitted` log — `_disputes` is private and neither view
 * enumerates who holds a commitment. If `judge` did not arrive on `args` (a topic that is not
 * in the ABI, a renamed input), the count would be zero forever, every seat would wait for
 * peers it could never see, and every dispute would settle by `DISPUTE_TIMEOUT` with nobody the
 * wiser. The hand-built `args` in `model.test.ts` cannot catch that class of mistake, which is
 * why this goes through `encodeEventTopics` + `parseEventLogs`.
 */
describe("the seat vote logs", () => {
  // Anvil account #1 in checksummed form, i.e. exactly what viem hands back for an indexed
  // address — the same shape the seat's own wallet address arrives in.
  const SEAT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
  const PEER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

  it("carries both the trial id and the seat, because both are indexed in the contract", () => {
    const e = toEventLike(liveLog("VoteCommitted", { id: 7n, judge: SEAT }) as never);

    expect(e.eventName).toBe("VoteCommitted");
    expect(e.args.id).toBe(7n);
    expect(e.args.judge).toBe(SEAT);
  });

  it("carries the revealed vote alongside the seat", () => {
    const e = toEventLike(liveLog("VoteRevealed", { id: 7n, judge: SEAT, breakWins: true }) as never);

    expect(e.args.breakWins).toBe(true);
    expect(e.args.judge).toBe(SEAT);
  });

  it("projects two seats sealing and one opening into a count a seat can gate on", () => {
    const model = replay([
      toEventLike(liveLog("VoteCommitted", { id: 7n, judge: SEAT }) as never),
      toEventLike(liveLog("VoteCommitted", { id: 7n, judge: PEER }) as never),
      toEventLike(liveLog("VoteRevealed", { id: 7n, judge: SEAT, breakWins: false }) as never),
    ]);

    const d = disputeState(model, 7);
    expect(d.committed).toEqual([SEAT.toLowerCase(), PEER.toLowerCase()]);
    expect(d.revealed).toEqual([SEAT.toLowerCase()]);
  });
});
