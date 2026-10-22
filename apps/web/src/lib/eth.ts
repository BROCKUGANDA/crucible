/**
 * Decimal ETH <-> wei, without ever touching a float.
 *
 * `parseFloat("0.1") * 1e18` is 100000000000000008, and that error becomes a stake that
 * is eight wei off what the operator typed. On a contract where the stake *is* the
 * economic commitment, an eight-wei lie is not acceptable, so everything here goes
 * through BigInt on the decimal string directly.
 *
 * The wei -> ETH direction is not implemented here. `weiToEth` in `@crucible/indexer` is
 * the one formatter in the repository — it builds every ETH string in every API payload,
 * and a browser that formatted the same wei its own server had already formatted would be
 * free to disagree about a stake. What is left here is the parsing direction, which is
 * input handling and has no server counterpart, and the display precision this app wants.
 */

import { MAX_DECIMALS, WEI_PER_ETH, weiToEth } from "@crucible/indexer";

/** Wei in one ETH, and the widest fraction wei can express — both from the shared source. */
export { MAX_DECIMALS, WEI_PER_ETH };

/**
 * Parse decimal ETH into wei.
 *
 * Returns null for anything that is not a well-formed non-negative decimal amount,
 * rather than 0 or NaN. The distinction matters at the call site: a null can disable a
 * button and explain why, while a silent 0 would send a transaction that reverts.
 */
export function parseEth(eth: string): bigint | null {
  const trimmed = eth.trim();
  if (trimmed === "") return null;
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === ".") return null;

  const [whole = "0", frac = ""] = trimmed.split(".");

  // Sub-wei precision would be silently truncated, which is the same class of lie as a
  // float error. Refuse instead.
  if (frac.length > MAX_DECIMALS) return null;

  const padded = frac.padEnd(MAX_DECIMALS, "0");
  if (whole === "" && padded === "") return null;

  try {
    return BigInt(whole || "0") * WEI_PER_ETH + BigInt(padded || "0");
  } catch {
    return null;
  }
}

/**
 * Wei -> a trimmed decimal ETH string.
 *
 * Named `formatWei`, not `formatEth`, on purpose: `forge.ts` already exports a
 * `formatEth` that takes an ETH-denominated *string* straight from the API. Two
 * functions with one name and different argument types is a trap, not a convenience.
 *
 * Four decimals is this app's display default — a wallet credit is not a scientific
 * instrument — and callers that must show every digit (a stake being signed for, down to
 * the wei) pass 18. `weiToEth`'s own default is full precision, because it is what the
 * API puts in a payload: a payload that rounds is a payload a reader cannot reconcile
 * against the chain.
 *
 * Display only — never round-trip a stake through this and back.
 */
export function formatWei(wei: bigint, maxDecimals = 4): string {
  return weiToEth(wei, maxDecimals);
}

/** Accept only a plain `0x` + 40 hex address. */
export function isEthAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value.trim());
}