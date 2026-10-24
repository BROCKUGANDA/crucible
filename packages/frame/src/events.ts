/**
 * The log shape the reducer eats.
 *
 * Structurally the indexer's `EventLike` (`packages/indexer/src/model.ts`), declared here
 * narrow on purpose: this package must not drag the whole projection in to render a replay,
 * and a caller that already has `EventLike` values passes them straight in.
 *
 * `args` is the decoded event payload. Values arrive as `bigint` for every `uint`, a checksummed
 * string for `address`, a `0x` hex string for `bytes32`, and a boolean for `bool` — viem's
 * decoding, not this module's invention. The coercions below exist because a fixture read from
 * JSON arrives with those bigints as decimal strings, and a reducer that silently reads `0`
 * where a reward was stored is a replay that reports the wrong money.
 */

export interface ChainLog {
  blockNumber: bigint;
  transactionHash: string;
  logIndex: number;
  address: string;
  eventName: string;
  args: Record<string, unknown>;
}

/** A log as it can be stored or shipped: the block number is a decimal string, not a bigint. */
export interface ChainLogWire {
  blockNumber: string;
  transactionHash: string;
  logIndex: number;
  address: string;
  eventName: string;
  args: Record<string, unknown>;
}

export function toChainLog(wire: ChainLogWire): ChainLog {
  return {
    ...wire,
    blockNumber: BigInt(wire.blockNumber),
  };
}

export function num(value: unknown): number {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return Math.trunc(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return Number.NaN;
}

export function big(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return null;
}

/** Wei as a decimal string. Money never crosses a float here, and null means "not known". */
export function weiString(value: unknown): string | null {
  const v = big(value);
  return v === null ? null : v.toString();
}

export function text(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  return null;
}

export function flag(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  return null;
}

/** The trial id an event is about, from the `indexed` first argument. */
export function trialIdOf(log: ChainLog): number {
  return num(log.args.id);
}
