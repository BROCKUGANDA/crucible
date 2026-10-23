import type { Hex } from "viem";

/**
 * What the keeper has spent getting other people's verdicts onto the chain.
 *
 * Gas is the network's toll, not the protocol's fee: the 5% the contract keeps (`FEE_BPS`) is
 * computed inside `CrucibleTrials` and never touches this ledger, and no number here enters the
 * conservation invariant. This is an operating cost carried by the signer account, and until now
 * it was invisible — the keeper read the transaction hash off `writeContract` and never looked at
 * the receipt, so nobody could say what the demo cost to run or when the wallet was about to be
 * unable to act.
 *
 * The ledger is deliberately fire-and-forget. `Warden.sweep` awaits one transaction at a time and
 * collects failures per trial so that one bad trial cannot stop the others from settling; a
 * receipt read that joined that await chain would make an accounting nicety capable of stalling
 * settlement. So observation never blocks, never throws into the sweep, and never retries: the
 * cost of a lost read is one entry in `unresolved`, and `unresolved` is published rather than
 * folded into the total.
 */

/** The two reads this ledger needs; the viem public client satisfies it structurally. */
export interface ChainReader {
  getTransactionReceipt(args: { hash: Hex }): Promise<{
    status?: "success" | "reverted";
    gasUsed: bigint;
    effectiveGasPrice?: bigint;
  }>;
  getBalance(args: { address: Hex }): Promise<bigint>;
}

export interface GasLedgerInput {
  reader: ChainReader;
  signer: Hex;
  /**
   * The floor an operator is willing to leave in the wallet. Absent means absent: the balance is
   * published and no alarm is raised, rather than inventing a threshold in code.
   */
  minBalance?: bigint | null;
  /** How many receipts may be in flight at once. Beyond it, an observation is refused out loud. */
  maxInFlight?: number;
  log?: (line: string) => void;
}

export interface GasLedgerSnapshot {
  /** Transactions whose cost was learned. A reverted one counts: its gas really was spent. */
  settledTxes: number;
  /** Sum of `gasUsed * effectiveGasPrice` over `settledTxes`, in wei. */
  weiSpent: bigint;
  /**
   * Transactions sent whose cost is unknown — an unreadable receipt, a receipt without an
   * effective gas price, or an observation refused for want of a slot. Kept separate because a
   * total quietly missing entries is a number nobody can act on, and understating an operating
   * cost is how a keeper ends up unable to sign.
   */
  unresolvedTxes: number;
  /** The signer's balance in wei, or null while the first read has not landed. */
  balanceWei: bigint | null;
  /** The threshold the operator set, or null when they set none. Null never alarms. */
  minBalanceWei: bigint | null;
  /** True only when both numbers above exist and the balance is below the floor. */
  lowBalance: boolean;
}

export interface GasLedger {
  /** Record that a transaction was sent. Returns immediately; never throws. */
  observe(hash: Hex): void;
  /** Refresh the signer balance. Concurrent calls share one read. */
  refreshBalance(): Promise<void>;
  snapshot(): GasLedgerSnapshot;
  /** Receipts still in flight. Present for tests and shutdown, not for the health payload. */
  inFlight(): number;
}

const DEFAULT_MAX_IN_FLIGHT = 16;

export function createGasLedger(input: GasLedgerInput): GasLedger {
  const { reader, signer } = input;
  const maxInFlight = input.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
  const log = input.log ?? (() => {});

  let settledTxes = 0;
  let weiSpent = 0n;
  let unresolvedTxes = 0;
  let flying = 0;
  let balanceWei: bigint | null = null;
  let balanceRead: Promise<void> | null = null;

  const unresolved = (hash: Hex, why: string): void => {
    unresolvedTxes += 1;
    // The hash is public and the reason is a message; neither identifies the account's key, and
    // an operator debugging a silent zero needs both.
    log(`gas unknown for ${hash}: ${why}`);
  };

  return {
    observe(hash: Hex): void {
      if (flying >= maxInFlight) {
        unresolved(hash, "receipt read refused: observation queue full");
        return;
      }

      flying += 1;
      void reader
        .getTransactionReceipt({ hash })
        .then((receipt) => {
          const price = receipt.effectiveGasPrice;
          if (price === undefined || price === null) {
            // A legacy receipt with no effective price is not a free transaction. Adding zero
            // here would report a cost the keeper demonstrably paid.
            unresolved(hash, "receipt carries no effective gas price");
            return;
          }
          weiSpent += receipt.gasUsed * price;
          settledTxes += 1;
        })
        .catch((err: unknown) => {
          unresolved(hash, err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          flying -= 1;
        });
    },

    async refreshBalance(): Promise<void> {
      if (balanceRead) return balanceRead;
      balanceRead = reader
        .getBalance({ address: signer })
        .then((wei) => {
          balanceWei = wei;
        })
        .catch((err: unknown) => {
          // Leave the previous reading in place rather than nulling it: a failed read is not
          // evidence that the wallet emptied, and a null here would silence the alarm.
          log(`balance read failed: ${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => {
          balanceRead = null;
        });
      return balanceRead;
    },

    snapshot(): GasLedgerSnapshot {
      const minBalanceWei = input.minBalance ?? null;
      return {
        settledTxes,
        weiSpent,
        unresolvedTxes,
        balanceWei,
        minBalanceWei,
        lowBalance:
          minBalanceWei !== null && balanceWei !== null && balanceWei < minBalanceWei,
      };
    },

    inFlight(): number {
      return flying;
    },
  };
}

/** Parse an operator-supplied wei floor. Absent, blank or unparseable means "no alarm". */
export function parseBalanceFloor(raw: string | undefined): bigint | null {
  if (raw === undefined || raw.trim() === "") return null;
  try {
    const wei = BigInt(raw.trim());
    return wei > 0n ? wei : null;
  } catch {
    return null;
  }
}
