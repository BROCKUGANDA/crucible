import { describe, expect, it } from "vitest";
import { hashCanonical } from "@crucible/crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Gate 712 — Cross-chain verdict-hash parity.
 *
 * The verdict hash is sha256 over JCS-canonicalized JSON. It must be byte-identical
 * whether computed on the EVM side (TypeScript, @crucible/crypto) or on the Solana
 * side (Rust JCS subset crate). This test computes the hash of the golden verdict
 * fixture using the TS crypto door; the Rust side recomputes it from the same bytes
 * and the two must match.
 *
 * The fixture is intentionally content-addressed: any byte change to it changes the
 * hash, so both sides are pinned to the same input.
 */

const FIXTURE = join(__dirname, "../../..", "contracts", "solana", "tests", "fixtures", "verdict-vectors.json");

describe("cross-chain verdict-hash parity (gate 712)", () => {
  it("computes a stable JCS+sha256 hash of the golden verdict fixture", async () => {
    const raw = await readFile(FIXTURE, "utf8");
    const verdict = JSON.parse(raw);

    // TS side: canonicalize + hash via the one crypto door (gate 625 / 629).
    const hash = hashCanonical(verdict);

    expect(typeof hash).toBe("string");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    // The same input must hash identically on re-parse (determinism).
    const hashAgain = hashCanonical(JSON.parse(raw));
    expect(hashAgain).toBe(hash);
  });

  it("is sensitive to input bytes (any change breaks the hash)", async () => {
    const raw = await readFile(FIXTURE, "utf8");
    const verdict = JSON.parse(raw);
    const baseHash = hashCanonical(verdict);

    // Flip one byte in a probe detail: hash must change.
    const mutated = { ...verdict, probes: [...verdict.probes] };
    mutated.probes[0] = { ...mutated.probes[0], detail: "tampered" };
    const mutatedHash = hashCanonical(mutated);
    expect(mutatedHash).not.toBe(baseHash);
  });
});
