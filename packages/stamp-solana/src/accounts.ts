/**
 * @file accounts.ts — decoding SPL accounts by hand.
 *
 * The verifier only ever needs four facts from an account: which mint it is,
 * who owns it, how much it holds, and who can mint more. Those live at fixed
 * offsets in the SPL Token account layouts (82 bytes for a mint, 165 for a
 * token account), and reading them directly means a verification failure
 * points at a byte rather than at "the SDK said no".
 *
 * Token-2022 accounts are the same prefix with extensions appended, so the
 * prefix decode works for both; `dataLength` is reported so the caller can see
 * which layout it is looking at.
 */

import { base58Encode } from "./base58.js";

export interface MintAccount {
  /** `null` when the mint authority is revoked. */
  mintAuthority: string | null;
  supply: bigint;
  decimals: number;
  isInitialized: boolean;
  /** `null` when freezing is disabled. */
  freezeAuthority: string | null;
  /** Raw byte length, so the caller can tell SPL Token from Token-2022. */
  dataLength: number;
  owner: string;
}

export interface TokenAccount {
  mint: string;
  owner: string;
  /** The token balance, in integer base units. */
  amount: bigint;
  /** `null` when no delegate is set. */
  delegate: string | null;
  state: "uninitialized" | "initialized" | "frozen";
  /** The native lamport reserve, for wrapped SOL accounts. */
  nativeReserve: bigint;
  dataLength: number;
}

const PUBKEY_LEN = 32;

class Reader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}

  get position(): number {
    return this.offset;
  }

  /** Advance without reading, for a fixed-size field the caller does not need. */
  skip(count: number): void {
    if (this.offset + count > this.bytes.length) throw new Error("account data truncated");
    this.offset += count;
  }

  u8(): number {
    if (this.offset + 1 > this.bytes.length) throw new Error("account data truncated");
    const value = this.bytes[this.offset]!;
    this.offset += 1;
    return value;
  }

  u32(): number {
    if (this.offset + 4 > this.bytes.length) throw new Error("account data truncated");
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 4);
    const value = view.getUint32(0, true);
    this.offset += 4;
    return value;
  }

  u64(): bigint {
    if (this.offset + 8 > this.bytes.length) throw new Error("account data truncated");
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 8);
    const value = view.getBigUint64(0, true);
    this.offset += 8;
    return value;
  }

  pubkey(): string {
    if (this.offset + PUBKEY_LEN > this.bytes.length) throw new Error("account data truncated");
    const slice = this.bytes.subarray(this.offset, this.offset + PUBKEY_LEN);
    this.offset += PUBKEY_LEN;
    return base58Encode(slice);
  }

  /** An SPL `COption<Pubkey>`: a 4-byte tag then the key. */
  optionalPubkey(): string | null {
    const tag = this.u32();
    if (tag === 0) {
      // The payload bytes are still present (the struct is fixed-size); skip them.
      this.offset += PUBKEY_LEN;
      return null;
    }
    if (tag !== 1) throw new Error(`unexpected COption tag ${tag}`);
    return this.pubkey();
  }
}

/** Decode a base64 account payload into bytes. */
export function decodeBase64(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, "base64"));
}

/** Decode an SPL Token (or Token-2022) mint account. */
export function parseMintAccount(dataBase64: string, owner: string): MintAccount {
  const bytes = decodeBase64(dataBase64);
  if (bytes.length < 82) throw new Error(`mint account is ${bytes.length} bytes, expected at least 82`);
  const reader = new Reader(bytes);
  const mintAuthority = reader.optionalPubkey();
  const supply = reader.u64();
  const decimals = reader.u8();
  const isInitialized = reader.u8() !== 0;
  const freezeAuthority = reader.optionalPubkey();
  return {
    mintAuthority,
    supply,
    decimals,
    isInitialized,
    freezeAuthority,
    dataLength: bytes.length,
    owner,
  };
}

/** Decode an SPL Token (or Token-2022) token account. */
export function parseTokenAccount(dataBase64: string): TokenAccount {
  const bytes = decodeBase64(dataBase64);
  if (bytes.length < 165) throw new Error(`token account is ${bytes.length} bytes, expected at least 165`);
  const reader = new Reader(bytes);
  const mint = reader.pubkey();
  const accountOwner = reader.pubkey();
  const amount = reader.u64();
  const delegate = reader.optionalPubkey();
  const stateByte = reader.u8();
  const state = stateByte === 0 ? "uninitialized" : stateByte === 1 ? "initialized" : "frozen";
  // is_native is a COption<u64>: 4-byte tag then 8 bytes.
  const nativeTag = reader.u32();
  reader.skip(8);
  const nativeReserve = nativeTag === 1 ? 1n : 0n;
  return {
    mint,
    owner: accountOwner,
    amount,
    delegate,
    state,
    nativeReserve,
    dataLength: bytes.length,
  };
}