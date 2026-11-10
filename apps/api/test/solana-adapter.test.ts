import { describe, expect, it } from "vitest";
import { isDevnetCluster, classifySolanaError, canSponsor } from "../src/solana-adapter.js";

describe("solana adapter", () => {
  it("devnet only", () => {
    expect(isDevnetCluster("devnet")).toBe(true);
    expect(isDevnetCluster("mainnet-beta")).toBe(false);
  });

  it("classifies errors", () => {
    expect(classifySolanaError(new Error("blockhash has expired"))).toBe("blockhash_expired");
    expect(classifySolanaError(new Error("insufficient lamports"))).toBe("insufficient_funds");
    expect(classifySolanaError(new Error("invalid signature verification"))).toBe("invalid_signature");
    expect(classifySolanaError(new Error("timeout"))).toBe("timeout");
  });

  it("sponsorship requires enterprise access", () => {
    expect(canSponsor({ pubkey: "x", sponsored: true }, true)).toBe(true);
    expect(canSponsor({ pubkey: "x", sponsored: true }, false)).toBe(false);
    expect(canSponsor({ pubkey: "x", sponsored: false }, true)).toBe(false);
  });
});
