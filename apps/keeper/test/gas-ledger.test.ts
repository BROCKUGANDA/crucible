import { describe, expect, it } from "vitest";
import { createGasLedger, parseBalanceFloor } from "../src/gas-ledger";
import type { Hex } from "viem";

/**
 * What the keeper spent, and what it cannot say it spent.
 *
 * The failure mode this file guards is an understated operating cost: a total that quietly drops
 * the receipts it could not read looks identical to a cheap keeper, and the operator learns the
 * difference when the wallet can no longer sign.
 */

type Receipt = {
  status?: "success" | "reverted";
  gasUsed: bigint;
  effectiveGasPrice?: bigint;
};

function fakeReader(opts: {
  receipts?: Record<string, Receipt | Error>;
  balance?: bigint | (() => Promise<bigint>);
}) {
  const calls: string[] = [];
  return {
    calls,
    reader: {
      async getTransactionReceipt({ hash }: { hash: Hex }) {
        calls.push(hash);
        const entry = opts.receipts?.[hash];
        if (entry instanceof Error) throw entry;
        if (entry === undefined) throw new Error(`no fixture for ${hash}`);
        return entry;
      },
      async getBalance(): Promise<bigint> {
        if (typeof opts.balance === "function") return opts.balance();
        if (opts.balance === undefined) throw new Error("node refused");
        return opts.balance;
      },
    },
  };
}

/** Let every fire-and-forget chain in the ledger run to its end. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0));
}

const A = "0xaaaa" as Hex;
const B = "0xbbbb" as Hex;
const signer = "0x0000000000000000000000000000000000000001" as Hex;

describe("gas ledger", () => {
  it("adds gasUsed times the effective price for every transaction it learns", async () => {
    const { reader } = fakeReader({
      receipts: {
        [A]: { status: "success", gasUsed: 100_000n, effectiveGasPrice: 2n },
        [B]: { status: "success", gasUsed: 50_000n, effectiveGasPrice: 3n },
      },
    });
    const ledger = createGasLedger({ reader, signer });

    ledger.observe(A);
    ledger.observe(B);
    await flush();

    const snap = ledger.snapshot();
    expect(snap.weiSpent).toBe(350_000n);
    expect(snap.settledTxes).toBe(2);
    expect(snap.unresolvedTxes).toBe(0);
  });

  it("counts a reverted transaction, because its gas was spent all the same", async () => {
    const { reader } = fakeReader({
      receipts: { [A]: { status: "reverted", gasUsed: 21_000n, effectiveGasPrice: 1n } },
    });
    const ledger = createGasLedger({ reader, signer });

    ledger.observe(A);
    await flush();

    expect(ledger.snapshot().weiSpent).toBe(21_000n);
    expect(ledger.snapshot().settledTxes).toBe(1);
  });

  it("refuses to read a receipt with no effective price as a free transaction", async () => {
    const { reader } = fakeReader({
      receipts: { [A]: { status: "success", gasUsed: 100_000n } },
    });
    const ledger = createGasLedger({ reader, signer });

    ledger.observe(A);
    await flush();

    const snap = ledger.snapshot();
    // Zero here would be the lie: the account paid, the ledger just does not know how much.
    expect(snap.weiSpent).toBe(0n);
    expect(snap.settledTxes).toBe(0);
    expect(snap.unresolvedTxes).toBe(1);
  });

  it("never throws into the sweep when a receipt read fails", async () => {
    const { reader } = fakeReader({ receipts: { [A]: new Error("connection reset") } });
    const seen: string[] = [];
    const ledger = createGasLedger({ reader, signer, log: (l) => seen.push(l) });

    expect(() => ledger.observe(A)).not.toThrow();
    await flush();

    expect(ledger.snapshot().unresolvedTxes).toBe(1);
    expect(seen.join(" ")).toContain("connection reset");
  });

  it("bounds in-flight observations instead of growing without limit", async () => {
    // A node that accepts the read and never answers: without a ceiling this is unbounded memory.
    const hanging = new Promise<never>(() => {});
    const ledger = createGasLedger({
      reader: {
        getTransactionReceipt: () => hanging,
        getBalance: () => hanging,
      },
      signer,
      maxInFlight: 2,
    });

    ledger.observe(A);
    ledger.observe(B);
    ledger.observe("0xcccc" as Hex);

    expect(ledger.inFlight()).toBe(2);
    // The third is refused out loud, not queued silently.
    expect(ledger.snapshot().unresolvedTxes).toBe(1);
  });

  it("publishes no balance alarm when the operator set no floor", async () => {
    const { reader } = fakeReader({ balance: 5n });
    const ledger = createGasLedger({ reader, signer });

    await ledger.refreshBalance();
    const snap = ledger.snapshot();
    expect(snap.balanceWei).toBe(5n);
    expect(snap.minBalanceWei).toBeNull();
    // 5 wei is below any sensible floor, and still not an alarm nobody asked for.
    expect(snap.lowBalance).toBe(false);
  });

  it("alarms once the balance is under the floor the operator named", async () => {
    const { reader } = fakeReader({ balance: 900n });
    const ledger = createGasLedger({ reader, signer, minBalance: 1000n });

    await ledger.refreshBalance();
    expect(ledger.snapshot().lowBalance).toBe(true);
  });

  it("keeps the last good balance when a refresh fails", async () => {
    let refuse = false;
    const ledger = createGasLedger({
      reader: {
        getTransactionReceipt: () => Promise.reject(new Error("unused")),
        getBalance: () => (refuse ? Promise.reject(new Error("down")) : Promise.resolve(7n)),
      },
      signer,
      minBalance: 10n,
    });

    await ledger.refreshBalance();
    expect(ledger.snapshot().balanceWei).toBe(7n);

    refuse = true;
    await ledger.refreshBalance();
    // A failed read is not evidence the wallet emptied; nulling it would silence the alarm.
    expect(ledger.snapshot().balanceWei).toBe(7n);
    expect(ledger.snapshot().lowBalance).toBe(true);
  });

  it("shares one read across concurrent refreshes", async () => {
    let reads = 0;
    const ledger = createGasLedger({
      reader: {
        getTransactionReceipt: () => Promise.reject(new Error("unused")),
        getBalance: () => {
          reads += 1;
          return new Promise((r) => setTimeout(() => r(1n), 5));
        },
      },
      signer,
    });

    await Promise.all([ledger.refreshBalance(), ledger.refreshBalance()]);
    expect(reads).toBe(1);
  });

  it("survives the health payload's JSON.stringify", async () => {
    const { reader } = fakeReader({
      receipts: { [A]: { status: "success", gasUsed: 100_000n, effectiveGasPrice: 2n } },
      balance: 3n,
    });
    const ledger = createGasLedger({ reader, signer, minBalance: 10n });
    ledger.observe(A);
    await ledger.refreshBalance();
    await flush();

    const snap = ledger.snapshot();
    // A BigInt in a JSON body throws TypeError, and the compose probe would read that as a dead
    // keeper rather than a badly-shaped payload. This is the mapping /health actually publishes.
    const body = {
      txesAccounted: Number(snap.settledTxes),
      weiSpent: snap.weiSpent.toString(),
      txesUnresolved: Number(snap.unresolvedTxes),
      balanceWei: snap.balanceWei === null ? null : snap.balanceWei.toString(),
      minBalanceWei: snap.minBalanceWei === null ? null : snap.minBalanceWei.toString(),
      lowBalance: snap.lowBalance,
    };
    expect(() => JSON.stringify(body)).not.toThrow();
    expect(JSON.parse(JSON.stringify(body))).toMatchObject({
      txesAccounted: 1,
      weiSpent: "200000",
      balanceWei: "3",
      minBalanceWei: "10",
      lowBalance: true,
    });
  });
});

describe("parseBalanceFloor", () => {
  it("treats absent, blank, non-numeric and non-positive as no floor", () => {
    expect(parseBalanceFloor(undefined)).toBeNull();
    expect(parseBalanceFloor("")).toBeNull();
    expect(parseBalanceFloor("   ")).toBeNull();
    expect(parseBalanceFloor("0.5 ether")).toBeNull();
    expect(parseBalanceFloor("0")).toBeNull();
    expect(parseBalanceFloor("-1")).toBeNull();
  });

  it("accepts a positive wei figure, with the whitespace an env file adds", () => {
    expect(parseBalanceFloor("1000000000000000000")).toBe(10n ** 18n);
    expect(parseBalanceFloor(" 42 \n")).toBe(42n);
  });
});
