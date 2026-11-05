import { createPublicClient, http, decodeEventLog, type PublicClient } from "viem";
import { foundry } from "viem/chains";
import { TRIALS_ABI } from "@crucible/smith";
import { openSync, writeSync, closeSync, fsyncSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The financial event ledger and the reconciliation that keeps it honest.
 *
 * ADR-0008 keeps the indexer in memory; this ledger is the one durable financial
 * artifact the treasury workstream asks for, and it is deliberately *not* a
 * database: an append-only JSONL file, one JSON object per line, written with
 * fsync so a killed process loses nothing that was acknowledged. Entries are
 * *derived from canonical chain evidence* (VerdictFinalized / Withdrawn logs plus
 * the trial state those logs point at) — never from a browser, an API response or
 * a webhook. Reconciliation compares the derived books against the chain's own
 * pull-ledger reads and lists every mismatch; it never edits history. A
 * discrepancy gets a correcting entry with a human behind it, or it stays open.
 *
 * Money law this module encodes (contract-spec.md; CrucibleTrials.sol):
 *   Paid      → agent payout = reward − fee, treasury = fee (fee = reward·500/10000)
 *   Slashed   → sponsor refunded the reward fee-free, skeptic 30% of the bond plus
 *               their stake back, treasury the remaining 70% of the bond
 *   Refunded  → sponsor gets the whole reward, the protocol earns nothing
 */

export type FinanceEntryType = "win-paid" | "fee-credited" | "slash-split" | "refund" | "withdrawal";

export interface FinanceEntry {
  /** Dedupe key: txHash:logIndex:address:amountWei:type. The file's uniqueness contract. */
  key: string;
  type: FinanceEntryType;
  trialId?: number;
  address: string;
  amountWei: string;
  txHash: string;
  blockNumber: string;
  logIndex: number;
  /** ISO-8601 time the entry was *written to the ledger*, not when the chain moved. */
  recordedAt: string;
}

export interface ReconciliationReport {
  ok: boolean;
  /** Per-address comparison of the derived books against the chain's credit ledger. */
  addresses: Array<{ address: string; derivedWei: string; chainWei: string; match: boolean }>;
  /** The escrow's own conservation identity, read from the chain. */
  conservation: { balanceWei: string; totalStakesWei: string; totalPendingWei: string; escrowedWei: string; match: boolean };
  mismatches: string[];
  entriesReplayed: number;
}

export type FinanceClient = Pick<
  PublicClient,
  "getLogs" | "getBlockNumber" | "readContract" | "getBalance"
>;

const FEE_BPS = 500n;
const BPS = 10_000n;
const SLASH_SKEPTIC_NUM = 3_000n; // 30% of the bond to a winning skeptic (CrucibleTrials.sol:151)

function entryKey(e: Omit<FinanceEntry, "key" | "recordedAt">): string {
  return `${e.txHash}:${e.logIndex}:${e.address.toLowerCase()}:${e.amountWei}:${e.type}`;
}

/**
 * Split one settled trial into its per-address credit deltas, from the trial's own
 * state and the verdict the chain recorded. Pure: the same trial and verdict always
 * produce the same books, which is what makes the reconciliation meaningful.
 */
export function deriveVerdictSplits(trial: {
  reward: bigint;
  bond: bigint;
  breakStake: bigint;
  breakSkeptic: string;
  sponsor: string;
  agentOperator: string;
}, verdict: number, treasury: string): Array<{ address: string; amountWei: bigint; type: FinanceEntryType }> {
  if (verdict === 1) {
    // Paid: the fee leaves the agent's payout, never the sponsor's reward.
    const fee = (trial.reward * FEE_BPS) / BPS;
    return [
      { address: trial.agentOperator, amountWei: trial.reward - fee, type: "win-paid" },
      { address: treasury, amountWei: fee, type: "fee-credited" },
    ];
  }
  if (verdict === 2) {
    // Slashed: sponsor refunded fee-free; bond split 30/70 skeptic/treasury;
    // the skeptic's stake comes back whole.
    const skepticCut = (trial.bond * SLASH_SKEPTIC_NUM) / BPS;
    return [
      { address: trial.sponsor, amountWei: trial.reward, type: "refund" },
      { address: trial.breakSkeptic, amountWei: skepticCut + trial.breakStake, type: "slash-split" },
      { address: treasury, amountWei: trial.bond - skepticCut, type: "fee-credited" },
    ];
  }
  if (verdict === 3) {
    // Refunded: no work, no fee. The protocol earns nothing on a trial nobody delivered.
    return [{ address: trial.sponsor, amountWei: trial.reward, type: "refund" }];
  }
  return []; // Verdict.None: nothing settled, nothing owed
}

/**
 * Replay the contract's money events from the chain and append anything the ledger
 * does not have yet. Appends are idempotent on the log identity, so the same block
 * range replayed twice — or replayed after a crash mid-write — produces the same
 * file. The ledger grows; existing lines are never rewritten.
 */
export async function replayFinancialEvents(args: {
  rpcUrl: string;
  trialsAddress: `0x${string}`;
  treasury: string;
  ledgerPath: string;
  fromBlock?: bigint;
  client?: FinanceClient;
}): Promise<{ appended: number; entries: FinanceEntry[] }> {
  const client =
    args.client ??
    createPublicClient({ chain: foundry, transport: http(args.rpcUrl) });
  const head = await client.getBlockNumber();
  const fromBlock = args.fromBlock ?? 0n;
  const logs = await client.getLogs({ address: args.trialsAddress, fromBlock, toBlock: head });

  const existing = readLedgerKeys(args.ledgerPath);
  const pending: FinanceEntry[] = [];
  const now = new Date().toISOString();

  for (const log of logs) {
    let decoded: { eventName: string; args: Record<string, unknown> };
    try {
      const d = decodeEventLog({
        abi: TRIALS_ABI,
        data: log.data,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      });
      decoded = { eventName: d.eventName, args: (d.args ?? {}) as Record<string, unknown> };
    } catch {
      continue; // an event outside the money surface says nothing about the books
    }

    if (decoded.eventName === "VerdictFinalized") {
      const trialId = Number(decoded.args.id);
      const verdict = Number(decoded.args.verdict);
      // The event names the verdict; the trial's own state names the amounts.
      const trial = (await client.readContract({
        address: args.trialsAddress,
        abi: TRIALS_ABI,
        functionName: "getTrial",
        args: [BigInt(trialId)],
      })) as unknown as {
        reward: bigint;
        bond: bigint;
        breakStake: bigint;
        breakSkeptic: string;
        sponsor: string;
        agentId: bigint;
      };
      const agentOperator = await client
        .readContract({
          address: args.trialsAddress,
          abi: TRIALS_ABI,
          functionName: "agents",
          args: [trial.agentId],
        })
        .then((a: unknown) => (a as unknown[])[0] as string);
      const splits = deriveVerdictSplits(
        {
          reward: trial.reward,
          bond: trial.bond,
          breakStake: trial.breakStake,
          breakSkeptic: trial.breakSkeptic,
          sponsor: trial.sponsor,
          agentOperator,
        },
        verdict,
        args.treasury,
      );
      for (const s of splits) {
        const partial = {
          type: s.type,
          trialId,
          address: s.address.toLowerCase(),
          amountWei: s.amountWei.toString(),
          txHash: log.transactionHash as string,
          blockNumber: log.blockNumber.toString(),
          logIndex: log.logIndex as number,
        };
        pending.push({ ...partial, key: entryKey(partial), recordedAt: now });
      }
    } else if (decoded.eventName === "Withdrawn") {
      const partial = {
        type: "withdrawal" as const,
        address: String(decoded.args.to).toLowerCase(),
        amountWei: (decoded.args.amount as bigint).toString(),
        txHash: log.transactionHash as string,
        blockNumber: log.blockNumber.toString(),
        logIndex: log.logIndex as number,
      };
      pending.push({ ...partial, key: entryKey(partial), recordedAt: now });
    }
  }

  const fresh = pending.filter((e) => !existing.has(e.key));
  if (fresh.length > 0) appendLedgerEntries(args.ledgerPath, fresh);
  return { appended: fresh.length, entries: readLedgerEntries(args.ledgerPath) };
}

/** Read the ledger's dedupe keys. A missing file is an empty ledger, not an error. */
export function readLedgerKeys(ledgerPath: string): Set<string> {
  return new Set(readLedgerEntries(ledgerPath).map((e) => e.key));
}

export function readLedgerEntries(ledgerPath: string): FinanceEntry[] {
  if (!existsSync(ledgerPath)) return [];
  const out: FinanceEntry[] = [];
  for (const line of readFileSync(ledgerPath, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as FinanceEntry);
    } catch {
      // A torn final line from a killed writer is history we cannot trust — skip it
      // rather than guess. The next replay re-derives and re-appends what is missing.
      continue;
    }
  }
  return out;
}

/** Append entries with fsync: an acknowledged line survives a killed process. */
function appendLedgerEntries(ledgerPath: string, entries: FinanceEntry[]): void {
  mkdirSync(dirname(ledgerPath), { recursive: true });
  const fd = openSync(ledgerPath, "a");
  try {
    for (const e of entries) {
      writeSync(fd, JSON.stringify(e) + "\n");
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Reconcile the derived books against the chain. Reads credit(addr) for every
 * address the ledger speaks about (bounded by the ledger, which grows with real
 * activity, not with enumeration) and asserts the escrow's conservation identity.
 * The report lists mismatches by name; fixing one is a human decision with a
 * correcting entry, never an automatic rewrite.
 */
export async function reconcile(args: {
  rpcUrl: string;
  trialsAddress: `0x${string}`;
  ledgerEntries: FinanceEntry[];
  maxAddresses?: number;
  client?: FinanceClient;
}): Promise<ReconciliationReport> {
  const client =
    args.client ??
    createPublicClient({ chain: foundry, transport: http(args.rpcUrl) });
  const abi = TRIALS_ABI.filter(
    (item) => item.type === "function" && ["credit", "totalStakes", "totalPending", "escrowed"].includes((item as { name?: string }).name ?? ""),
  );
  const read = async (functionName: string, args2: unknown[] = []): Promise<bigint> =>
    (await client.readContract({ address: args.trialsAddress, abi, functionName: functionName as never, args: args2 as never })) as bigint;

  const signed = new Map<string, bigint>();
  for (const e of args.ledgerEntries) {
    const amt = BigInt(e.amountWei);
    const cur = signed.get(e.address) ?? 0n;
    signed.set(e.address, e.type === "withdrawal" ? cur - amt : cur + amt);
  }

  const addresses = [...signed.keys()].sort();
  const bounded = args.maxAddresses ?? 500;
  if (addresses.length > bounded) {
    return {
      ok: false,
      addresses: [],
      conservation: { balanceWei: "0", totalStakesWei: "0", totalPendingWei: "0", escrowedWei: "0", match: false },
      mismatches: [`ledger speaks about ${addresses.length} addresses; reconciliation is bounded to ${bounded} — extend maxAddresses deliberately, never silently`],
      entriesReplayed: args.ledgerEntries.length,
    };
  }

  const mismatches: string[] = [];
  const perAddress: ReconciliationReport["addresses"] = [];
  for (const addr of addresses) {
    const chainWei = await read("credit", [addr]);
    const ours = signed.get(addr) ?? 0n;
    const match = chainWei === ours;
    perAddress.push({ address: addr, derivedWei: ours.toString(), chainWei: chainWei.toString(), match });
    if (!match) mismatches.push(`${addr}: ledger says ${ours}, chain says ${chainWei}`);
  }

  const [totalStakes, totalPending, escrowed] = await Promise.all([
    read("totalStakes"),
    read("totalPending"),
    read("escrowed"),
  ]);
  const balance = await client.getBalance({ address: args.trialsAddress });
  const conservationMatch = balance === totalStakes + totalPending + escrowed;
  if (!conservationMatch) {
    mismatches.push(
      `conservation: balance ${balance} != totalStakes ${totalStakes} + totalPending ${totalPending} + escrowed ${escrowed}`,
    );
  }

  return {
    ok: mismatches.length === 0,
    addresses: perAddress,
    conservation: {
      balanceWei: balance.toString(),
      totalStakesWei: totalStakes.toString(),
      totalPendingWei: totalPending.toString(),
      escrowedWei: escrowed.toString(),
      match: conservationMatch,
    },
    mismatches,
    entriesReplayed: args.ledgerEntries.length,
  };
}
