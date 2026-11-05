import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAbiParameters, encodeEventTopics, getAbiItem } from "viem";
import { TRIALS_ABI } from "@crucible/smith";
import {
  deriveVerdictSplits,
  readLedgerEntries,
  replayFinancialEvents,
  reconcile,
  type FinanceClient,
  type FinanceEntry,
} from "../src/finance.js";

/**
 * The financial ledger is the artifact an auditor reads after a dispute, so the
 * tests defend its two hard properties: the books it derives are a pure function
 * of the chain's own state (same verdict → same splits, down to the wei), and the
 * file it writes is append-only and idempotent (a replay — or a crash between
 * write and fsync — never duplicates or rewrites a line). The reconciliation is
 * then a comparison, not a trust decision: a mismatched address is named, never
 * silently corrected.
 */

const TRIALS = "0x00000000000000000000000000000000000000aa" as const;
const TREASURY = "0x00000000000000000000000000000000000000bb";
const SPONSOR = "0x00000000000000000000000000000000000000cc";
const OPERATOR = "0x00000000000000000000000000000000000000dd";
const SKEPTIC = "0x00000000000000000000000000000000000000ee";
const REWARD = 10n ** 18n;
const BOND = 2n * 10n ** 17n;
const BREAK_STAKE = 10n ** 16n;

const dirs: string[] = [];
function tempLedger(): string {
  const dir = mkdtempSync(join(tmpdir(), "crucible-finance-"));
  dirs.push(dir);
  return join(dir, "ledger", "finance.jsonl");
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("deriveVerdictSplits", () => {
  const trial = {
    reward: REWARD,
    bond: BOND,
    breakStake: BREAK_STAKE,
    breakSkeptic: SKEPTIC,
    sponsor: SPONSOR,
    agentOperator: OPERATOR,
  };

  it("Paid: agent earns reward minus exactly the 5% fee; treasury the fee", () => {
    const splits = deriveVerdictSplits(trial, 1, TREASURY);
    expect(splits).toHaveLength(2);
    expect(splits[0]).toMatchObject({ address: OPERATOR, type: "win-paid" });
    expect(splits[0]!.amountWei).toBe(REWARD - (REWARD * 500n) / 10000n);
    expect(splits[1]).toMatchObject({ address: TREASURY, type: "fee-credited" });
    expect(splits[1]!.amountWei).toBe(5n * 10n ** 16n);
    // The split is conservation-preserving by construction: nothing is invented.
    expect(splits.reduce((sum, s) => sum + s.amountWei, 0n)).toBe(REWARD);
  });

  it("Slashed: sponsor refunded fee-free, skeptic 30% of bond plus stake, treasury the rest", () => {
    const splits = deriveVerdictSplits(trial, 2, TREASURY);
    const byAddress = new Map(splits.map((s) => [s.address, s]));
    expect(byAddress.get(SPONSOR)).toMatchObject({ type: "refund", amountWei: REWARD });
    expect(byAddress.get(SKEPTIC)!.amountWei).toBe((BOND * 3000n) / 10000n + BREAK_STAKE);
    expect(byAddress.get(TREASURY)!.amountWei).toBe(BOND - (BOND * 3000n) / 10000n);
    expect(splits.reduce((sum, s) => sum + s.amountWei, 0n)).toBe(REWARD + BOND + BREAK_STAKE);
  });

  it("Refunded: the sponsor gets everything and the protocol earns nothing", () => {
    const splits = deriveVerdictSplits(trial, 3, TREASURY);
    expect(splits).toEqual([{ address: SPONSOR, amountWei: REWARD, type: "refund" }]);
  });

  it("Verdict.None settles nothing", () => {
    expect(deriveVerdictSplits(trial, 0, TREASURY)).toEqual([]);
  });
});

/** A fake transport whose books answer exactly what the chain would answer. */
function fakeClient(opts: {
  logs: Array<{ topics: string[]; data: string; txHash: string; logIndex: number; blockNumber: bigint }>;
  trials: Map<bigint, Record<string, unknown>>;
  agents: Map<bigint, [string, string, string, bigint, number]>;
  credits: Map<string, bigint>;
  totals?: { stakes: bigint; pending: bigint; escrowed: bigint };
  balance?: bigint;
}): FinanceClient {
  return {
    getBlockNumber: async () => 100n,
    getLogs: async () =>
      opts.logs.map((l) => ({
        address: TRIALS,
        topics: l.topics as [`0x${string}`, ...`0x${string}`[]],
        data: l.data as `0x${string}`,
        transactionHash: l.txHash as `0x${string}`,
        logIndex: l.logIndex,
        blockNumber: l.blockNumber,
      })),
    readContract: async (args: { functionName: string; args?: unknown[] }) => {
      if (args.functionName === "getTrial") return opts.trials.get(args.args![0] as bigint);
      if (args.functionName === "agents") return opts.agents.get(args.args![0] as bigint);
      if (args.functionName === "credit") return opts.credits.get(String(args.args![0])) ?? 0n;
      if (args.functionName === "totalStakes") return opts.totals!.stakes;
      if (args.functionName === "totalPending") return opts.totals!.pending;
      if (args.functionName === "escrowed") return opts.totals!.escrowed;
      throw new Error(`fakeClient: unexpected read ${args.functionName}`);
    },
    getBalance: async () => opts.balance ?? 0n,
  } as unknown as FinanceClient;
}

function verdictLog(id: bigint, verdict: number, txHash: string, logIndex = 0) {
  // encodeEventTopics/encodeAbiParameters via the real ABI, so the decoder under
  // test decodes genuinely encoded logs rather than a hand-typed fixture.
  const item = getAbiItem({ abi: TRIALS_ABI, name: "VerdictFinalized" });
  const topics = encodeEventTopics({ abi: TRIALS_ABI, eventName: "VerdictFinalized", args: { id, verdict } });
  const dataInputs = item.inputs.filter((i: { indexed?: boolean }) => !i.indexed);
  const data = encodeAbiParameters(dataInputs, [verdict, 0n]);
  return { topics, data, txHash, logIndex, blockNumber: 42n };
}

describe("replayFinancialEvents", () => {
  it("derives entries from a settled win and is idempotent on replay", async () => {
    const ledgerPath = tempLedger();
    const client = fakeClient({
      logs: [verdictLog(1n, 1, `0x${"77".repeat(32)}`)],
      trials: new Map([
        [1n, { reward: REWARD, bond: BOND, breakStake: 0n, breakSkeptic: "0x0", sponsor: SPONSOR, agentId: 1n }],
      ]),
      agents: new Map([[1n, [OPERATOR, "0x0", "ipfs://x", 0n, 0]]]),
      credits: new Map(),
    });
    const first = await replayFinancialEvents({
      rpcUrl: "unused",
      trialsAddress: TRIALS,
      treasury: TREASURY,
      ledgerPath,
      client,
    });
    expect(first.appended).toBe(2);
    const entries = readLedgerEntries(ledgerPath);
    expect(entries.map((e) => e.type).sort()).toEqual(["fee-credited", "win-paid"]);
    expect(entries.every((e) => e.trialId === 1)).toBe(true);

    // The same range replayed appends nothing: the log identity is the dedupe key.
    const second = await replayFinancialEvents({
      rpcUrl: "unused",
      trialsAddress: TRIALS,
      treasury: TREASURY,
      ledgerPath,
      client,
    });
    expect(second.appended).toBe(0);
    expect(readLedgerEntries(ledgerPath)).toHaveLength(2);
  });

  it("skips a torn final line and re-derives it on the next replay", async () => {
    const ledgerPath = tempLedger();
    mkdirSync(join(ledgerPath, ".."), { recursive: true });
    writeFileSync(ledgerPath, '{"key":"old","type":"refund","address":"0xcc","amountWei":"1"}\n{"key":"torn"');
    const entries = readLedgerEntries(ledgerPath);
    expect(entries).toHaveLength(1); // the torn line is skipped, not guessed
    expect(entries[0]!.key).toBe("old");
  });

  it("records a withdrawal as a debit against the withdrawing address", async () => {
    const ledgerPath = tempLedger();
    const item = getAbiItem({ abi: TRIALS_ABI, name: "Withdrawn" });
    const topics = encodeEventTopics({ abi: TRIALS_ABI, eventName: "Withdrawn", args: { to: TREASURY } });
    const data = encodeAbiParameters(
      item.inputs.filter((i: { indexed?: boolean }) => !i.indexed),
      [5n * 10n ** 16n],
    );
    const client = fakeClient({
      logs: [{ topics, data, txHash: `0x${"88".repeat(32)}`, logIndex: 1, blockNumber: 50n }],
      trials: new Map(),
      agents: new Map(),
      credits: new Map(),
    });
    const { entries } = await replayFinancialEvents({
      rpcUrl: "unused",
      trialsAddress: TRIALS,
      treasury: TREASURY,
      ledgerPath,
      client,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "withdrawal", address: TREASURY, amountWei: (5n * 10n ** 16n).toString() });
  });
});

describe("reconcile", () => {
  function entry(over: Partial<FinanceEntry>): FinanceEntry {
    return {
      key: over.key ?? "k",
      type: "fee-credited",
      address: TREASURY,
      amountWei: "5",
      txHash: `0x${"aa".repeat(32)}`,
      blockNumber: "1",
      logIndex: 0,
      recordedAt: new Date().toISOString(),
      ...over,
    };
  }

  it("reports ok when every address's derived books equal the chain's credit ledger", async () => {
    const client = fakeClient({
      logs: [],
      trials: new Map(),
      agents: new Map(),
      credits: new Map([
        [TREASURY, 5n],
        [OPERATOR, 95n],
      ]),
      totals: { stakes: 100n, pending: 100n, escrowed: 0n },
      balance: 200n,
    });
    const report = await reconcile({
      rpcUrl: "unused",
      trialsAddress: TRIALS,
      client,
      ledgerEntries: [
        entry({ address: TREASURY, amountWei: "5" }),
        entry({ address: OPERATOR, type: "win-paid", amountWei: "95" }),
        // The treasury already withdrew its fee: debit on the same address.
        entry({ address: TREASURY, type: "withdrawal", amountWei: "0" }),
      ],
    });
    expect(report.ok).toBe(true);
    expect(report.conservation.match).toBe(true);
    expect(report.mismatches).toEqual([]);
  });

  it("names the address when the ledger and the chain disagree", async () => {
    const client = fakeClient({
      logs: [],
      trials: new Map(),
      agents: new Map(),
      credits: new Map([[TREASURY, 4n]]), // chain lost a wei somewhere
      totals: { stakes: 0n, pending: 0n, escrowed: 0n },
      balance: 0n,
    });
    const report = await reconcile({
      rpcUrl: "unused",
      trialsAddress: TRIALS,
      client,
      ledgerEntries: [entry({ address: TREASURY, amountWei: "5" })],
    });
    expect(report.ok).toBe(false);
    expect(report.mismatches[0]).toContain(TREASURY);
    expect(report.mismatches[0]).toContain("ledger says 5");
    expect(report.mismatches[0]).toContain("chain says 4");
  });

  it("reports a broken conservation identity by name", async () => {
    const client = fakeClient({
      logs: [],
      trials: new Map(),
      agents: new Map(),
      credits: new Map(),
      totals: { stakes: 10n, pending: 10n, escrowed: 10n },
      balance: 25n, // one wei short
    });
    const report = await reconcile({
      rpcUrl: "unused",
      trialsAddress: TRIALS,
      client,
      ledgerEntries: [],
    });
    expect(report.ok).toBe(false);
    expect(report.mismatches[0]).toContain("conservation");
    expect(report.conservation.match).toBe(false);
  });

  it("refuses to silently reconcile a ledger larger than its address bound", async () => {
    const client = fakeClient({
      logs: [],
      trials: new Map(),
      agents: new Map(),
      credits: new Map(),
      totals: { stakes: 0n, pending: 0n, escrowed: 0n },
    });
    const many: FinanceEntry[] = [];
    for (let i = 0; i < 4; i++) {
      many.push(entry({ address: `0x000000000000000000000000000000000000000${i}`, amountWei: "1", key: `k${i}` }));
    }
    const report = await reconcile({
      rpcUrl: "unused",
      trialsAddress: TRIALS,
      client,
      ledgerEntries: many,
      maxAddresses: 2,
    });
    expect(report.ok).toBe(false);
    expect(report.mismatches[0]).toContain("bounded");
  });

  it("round-trips a real ledger file through replay into reconcile", async () => {
    const ledgerPath = tempLedger();
    const fee = (REWARD * 500n) / 10000n;
    const client = fakeClient({
      logs: [verdictLog(1n, 1, `0x${"77".repeat(32)}`)],
      trials: new Map([
        [1n, { reward: REWARD, bond: BOND, breakStake: 0n, breakSkeptic: "0x0", sponsor: SPONSOR, agentId: 1n }],
      ]),
      agents: new Map([[1n, [OPERATOR, "0x0", "ipfs://x", 0n, 0]]]),
      credits: new Map([
        [TREASURY, fee],
        [OPERATOR, REWARD - fee],
      ]),
      // After settlement the reward and bond have left escrow: pending holds the
      // payouts, stakes holds the agent's freed bond, escrowed is zero.
      totals: { stakes: BOND, pending: REWARD, escrowed: 0n },
      balance: REWARD + BOND,
    });
    const { entries } = await replayFinancialEvents({
      rpcUrl: "unused",
      trialsAddress: TRIALS,
      treasury: TREASURY,
      ledgerPath,
      client,
    });
    const report = await reconcile({
      rpcUrl: "unused",
      trialsAddress: TRIALS,
      client,
      ledgerEntries: entries,
    });
    expect(report.ok).toBe(true);
    expect(report.addresses).toHaveLength(2);
    // The file on disk is the audit artifact: readable, line-per-entry, complete.
    const lines = readFileSync(ledgerPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toHaveProperty("key");
  });
});
