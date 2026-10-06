/**
 * Decimal ETH <-> wei, without ever touching a float.
 *
 * `parseFloat("0.1") * 1e18` is 100000000000000008, and that error becomes a stake that
 * is eight wei off what the operator typed. On a contract where the stake *is* the
 * economic commitment, an eight-wei lie is not acceptable, so everything here goes
 * through BigInt on the decimal string directly.
 */

/** Wei in one ETH. */
export const WEI_PER_ETH = 10n ** 18n;

/** The largest number of decimal places an ETH amount can express. */
export const MAX_DECIMALS = 18;

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
 * Display only — never round-trip a stake through this and back.
 */
export function formatWei(wei: bigint, maxDecimals = 4): string {
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  const whole = abs / WEI_PER_ETH;
  const frac = (abs % WEI_PER_ETH).toString().padStart(MAX_DECIMALS, "0").slice(0, maxDecimals);
  const trimmed = frac.replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${trimmed ? `.${trimmed}` : ""}`;
}

/** Accept only a plain `0x` + 40 hex address. */
export function isEthAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value.trim());
}