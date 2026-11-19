import { describe, expect, it } from "vitest";
import { base58Decode, base58Encode, isSolanaAddress } from "../src/base58.js";

/** A real 32-byte address, and its base58 form. */
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

describe("base58", () => {
  it("round-trips a 32-byte key", () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);
    const encoded = base58Encode(bytes);
    expect(base58Decode(encoded)).toEqual(bytes);
  });

  it("decodes the token program id to 32 bytes", () => {
    const bytes = base58Decode(TOKEN_PROGRAM);
    expect(bytes).not.toBeNull();
    expect(bytes!.length).toBe(32);
  });

  it("preserves leading zero bytes as leading '1's", () => {
    expect(base58Decode(SYSTEM_PROGRAM)!.length).toBe(32);
    expect(base58Encode(new Uint8Array(32))).toBe(SYSTEM_PROGRAM);
  });

  it("rejects a character outside the alphabet", () => {
    // '0', 'O', 'I' and 'l' are deliberately absent from base58.
    expect(base58Decode("0OIl")).toBeNull();
  });

  it("validates address length", () => {
    expect(isSolanaAddress(TOKEN_PROGRAM)).toBe(true);
    expect(isSolanaAddress("abc")).toBe(false);
    expect(isSolanaAddress("0".repeat(32))).toBe(false);
  });
});