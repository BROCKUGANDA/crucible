import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { keccak256, hexToBytes, toHex, decodeAbiParameters, encodeAbiParameters, encodeEventTopics, parseEventLogs } from "viem";
import { TRIALS_ABI } from "@crucible/smith";
import { bloomMayContain, Scribe, toEventLike } from "../src/scribe.js";
import { foundry } from "viem/chains";
import { applyEvent, emptyModel } from "../src/model.js";

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
 */
async function lyingNode(opts: { logs: unknown[]; quietBlocks?: boolean }): Promise<{
  url: string;
  address: `0x${string}`;
  trialTopic: `0x${string}`;
  close: () => void;
}> {
  const trialTopic = encodeEventTopics({ abi: TRIALS_ABI, eventName: "TrialCreated" })[0] as `0x${string}`;
  const digest = hexToBytes(keccak256(trialTopic));
  const bloom = new Uint8Array(256);
  if (!opts.quietBlocks) {
    for (let i = 0; i < 3; i++) {
      const bit = (((digest[i * 2] ?? 0) << 8) | (digest[i * 2 + 1] ?? 0)) & 0x7ff;
      bloom[255 - (bit >> 3)] |= 1 << (bit & 7);
    }
  }

  const address = "0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0" as `0x${string}`;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { id, method } = JSON.parse(body || "{}") as { id: number; method: string };
      const result =
        method === "eth_blockNumber"
          ? "0x6"
          : method === "eth_getLogs"
            ? opts.logs
            : method === "eth_chainId"
              ? "0x7a69"
              : {
                  number: "0x1",
                  hash: `0x${"11".repeat(32)}`,
                  parentHash: `0x${"22".repeat(32)}`,
                  nonce: "0x0",
                  sha3Uncles: `0x${"33".repeat(32)}`,
                  logsBloom: toHex(bloom),
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
                };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
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
    expect(scribe.status.syncError).toContain("logsBloom");
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
});
