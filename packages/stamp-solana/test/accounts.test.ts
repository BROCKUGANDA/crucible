import { describe, expect, it } from "vitest";
import { base58Encode } from "../src/base58.js";
import { parseMintAccount, parseTokenAccount } from "../src/accounts.js";

/** Build a fake 32-byte key from a single fill byte. */
function key(fill: number): { bytes: Uint8Array; base58: string } {
  const bytes = new Uint8Array(32).fill(fill);
  return { bytes, base58: base58Encode(bytes) };
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.length).setUint32(offset, value, true);
}

function writeU64(bytes: Uint8Array, offset: number, value: bigint): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.length).setBigUint64(offset, value, true);
}

/** 82-byte SPL mint: authority, supply, decimals, initialized, freeze authority. */
function mintBytes(options: {
  mintAuthority: Uint8Array | null;
  supply: bigint;
  decimals: number;
  freezeAuthority?: Uint8Array | null;
}): Uint8Array {
  const bytes = new Uint8Array(82);
  writeU32(bytes, 0, options.mintAuthority ? 1 : 0);
  if (options.mintAuthority) bytes.set(options.mintAuthority, 4);
  writeU64(bytes, 36, options.supply);
  bytes[44] = options.decimals;
  bytes[45] = 1; // is_initialized
  const freeze = options.freezeAuthority ?? null;
  writeU32(bytes, 46, freeze ? 1 : 0);
  if (freeze) bytes.set(freeze, 50);
  return bytes;
}

/** 165-byte SPL token account: mint, owner, amount, delegate, state, is_native. */
function tokenAccountBytes(options: {
  mint: Uint8Array;
  owner: Uint8Array;
  amount: bigint;
  delegate?: Uint8Array | null;
  state?: number;
  native?: bigint | null;
}): Uint8Array {
  const bytes = new Uint8Array(165);
  bytes.set(options.mint, 0);
  bytes.set(options.owner, 32);
  writeU64(bytes, 64, options.amount);
  writeU32(bytes, 72, options.delegate ? 1 : 0);
  if (options.delegate) bytes.set(options.delegate, 76);
  bytes[108] = options.state ?? 1;
  writeU32(bytes, 109, options.native !== null && options.native !== undefined ? 1 : 0);
  if (options.native !== null && options.native !== undefined) writeU64(bytes, 113, options.native);
  return bytes;
}

describe("parseMintAccount", () => {
  it("decodes authority, supply, decimals and freeze authority", () => {
    const authority = key(7);
    const freeze = key(9);
    const mint = parseMintAccount(
      Buffer.from(mintBytes({ mintAuthority: authority.bytes, supply: 123_456n, decimals: 6, freezeAuthority: freeze.bytes })).toString("base64"),
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    );
    expect(mint.mintAuthority).toBe(authority.base58);
    expect(mint.supply).toBe(123_456n);
    expect(mint.decimals).toBe(6);
    expect(mint.isInitialized).toBe(true);
    expect(mint.freezeAuthority).toBe(freeze.base58);
    expect(mint.dataLength).toBe(82);
  });

  it("reports a revoked mint authority as null", () => {
    const mint = parseMintAccount(
      Buffer.from(mintBytes({ mintAuthority: null, supply: 1n, decimals: 0 })).toString("base64"),
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    );
    expect(mint.mintAuthority).toBeNull();
    expect(mint.freezeAuthority).toBeNull();
  });

  it("refuses an account that is too short", () => {
    expect(() => parseMintAccount(Buffer.from(new Uint8Array(40)).toString("base64"), "x")).toThrow(/at least 82/);
  });

  it("reads a Token-2022 mint with extension bytes appended", () => {
    const extended = new Uint8Array(200);
    extended.set(mintBytes({ mintAuthority: null, supply: 500n, decimals: 9 }));
    const mint = parseMintAccount(Buffer.from(extended).toString("base64"), "x");
    expect(mint.supply).toBe(500n);
    expect(mint.dataLength).toBe(200);
  });
});

describe("parseTokenAccount", () => {
  it("decodes mint, owner and amount", () => {
    const mint = key(3);
    const owner = key(4);
    const parsed = parseTokenAccount(
      Buffer.from(tokenAccountBytes({ mint: mint.bytes, owner: owner.bytes, amount: 1_000_000n })).toString("base64"),
    );
    expect(parsed.mint).toBe(mint.base58);
    expect(parsed.owner).toBe(owner.base58);
    expect(parsed.amount).toBe(1_000_000n);
    expect(parsed.delegate).toBeNull();
    expect(parsed.state).toBe("initialized");
  });

  it("reports a frozen account", () => {
    const parsed = parseTokenAccount(
      Buffer.from(
        tokenAccountBytes({ mint: key(1).bytes, owner: key(2).bytes, amount: 0n, state: 2 }),
      ).toString("base64"),
    );
    expect(parsed.state).toBe("frozen");
  });

  it("refuses an account that is too short", () => {
    expect(() => parseTokenAccount(Buffer.from(new Uint8Array(64)).toString("base64"))).toThrow(/at least 165/);
  });

  it("reads the exact base-unit amount without floating point", () => {
    const parsed = parseTokenAccount(
      Buffer.from(
        tokenAccountBytes({
          mint: key(1).bytes,
          owner: key(2).bytes,
          amount: 9_007_199_254_740_993n, // 2^53 + 1: not representable as a double
        }),
      ).toString("base64"),
    );
    expect(parsed.amount).toBe(9_007_199_254_740_993n);
  });
});