/**
 * Backfill benchmark — measures the cost of a chain replay at several sizes.
 *
 * This is a measurement tool, not a gate. CI cannot use wall-clock as a
 * hard assertion: the same suite runs on a host that also serves production,
 * where the same code is an order of magnitude slower. Run this on a quiet
 * machine to see the shape.
 *
 *   node --experimental-strip-types packages/indexer/scripts/bench-backfill.ts
 */
import { performance } from "node:perf_hooks";
import { emptyModel, replay } from "../src/index.js";

const SPONSOR = "0x1111111111111111111111111111111111111111";
const OPERATOR = "0x2222222222222222222222222222222222222222";

function ev(eventName: string, args: Record<string, unknown>, blockNumber: bigint) {
  return { blockNumber, transactionHash: "0x" + "11".repeat(32), logIndex: 0, address: "0x" + "33".repeat(20), eventName, args } as never;
}

function storyEvents(count: number) {
  const out: never[] = [];
  for (let id = 1; id <= count; id += 1) {
    const b = BigInt(id * 10);
    out.push(
      ev("TrialCreated", { id: BigInt(id), sponsor: SPONSOR, specCID: "0x" + "aa".repeat(32), testsCID: "0x" + "bb".repeat(32), reward: 10n ** 18n, bond: 2n * 10n ** 17n, deadline: 1_700_000_000 + id, breakWindow: 43_200n }, b),
      ev("AgentRegistered", { agentId: BigInt(id), operator: OPERATOR, runner: OPERATOR, metadataURI: "ipfs://m", stake: 10n ** 18n }, b + 1n),
      ev("TrialClaimed", { id: BigInt(id), agentId: BigInt(id), bond: 2n * 10n ** 17n }, b + 2n),
      ev("RunSubmitted", { id: BigInt(id), agentId: BigInt(id), runHash: "0x" + "cc".repeat(32) }, b + 3n),
      ev("VerdictFinalized", { id: BigInt(id), verdict: 1, agentPayout: 95n * 10n ** 16n }, b + 4n),
    );
  }
  return out;
}

const sizes = [250, 500, 1000, 2000, 4000];
const results: { trials: number; logs: number; bestMs: number }[] = [];

for (const n of sizes) {
  const events = storyEvents(n);
  const runs: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    const started = performance.now();
    replay(events, emptyModel());
    runs.push(performance.now() - started);
  }
  const bestMs = Math.min(...runs);
  results.push({ trials: n, logs: events.length, bestMs });
}

console.log("trials\tlogs\tbest_ms\tms_per_log\tratio_vs_prev");
let prev: number | null = null;
for (const r of results) {
  const ratio = prev === null ? 1 : r.bestMs / prev;
  console.log(
    `${r.trials}\t${r.logs}\t${r.bestMs.toFixed(1)}\t${(r.bestMs / r.logs).toFixed(4)}\t${ratio.toFixed(2)}x`,
  );
  prev = r.bestMs;
}
const perLog = results.map((r) => r.bestMs / r.logs);
console.log(`\nper-log cost: min ${Math.min(...perLog).toFixed(4)}ms  max ${Math.max(...perLog).toFixed(4)}ms`);
console.log(`growth in per-log cost (last/first): ${(perLog[perLog.length - 1] / perLog[0]).toFixed(2)}x`);
