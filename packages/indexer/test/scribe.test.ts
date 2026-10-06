import { describe, expect, it } from "vitest";
import { decodeAbiParameters, encodeAbiParameters, encodeEventTopics, parseEventLogs } from "viem";
import { TRIALS_ABI } from "@crucible/smith";
import { toEventLike } from "../src/scribe.js";
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
