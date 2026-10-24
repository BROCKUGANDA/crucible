import type { ModelAdapter, ModelVerdict } from "../types.js";

/**
 * Stub model adapter — the CI tier runs exclusively on this.
 * Zero network, zero API spend, byte-stable fixtures.
 * Verdicts are derived deterministically from the claim hash so the same
 * fixture always yields the same verdict across runs (determinism gate 424).
 */
export class StubModelAdapter implements ModelAdapter {
  readonly id: string;

  constructor(private readonly promptVersion: string, id?: string) {
    this.id = id ?? "stub";
  }

  grade(artifact: { claimHash: string; payload: unknown }, promptVersion: string): Promise<ModelVerdict> {
    const hash = stableHash(`${artifact.claimHash}|${promptVersion}|${JSON.stringify(artifact.payload)}`);
    const verdict = hash % 3 === 0 ? "PASS" : hash % 3 === 1 ? "VOID" : "FAIL";
    const confidence = 0.5 + (hash % 50) / 100; // 0.5..0.99
    return Promise.resolve({
      verdict,
      confidence,
      latencyMs: 5 + (hash % 50), // deterministic, fast
      promptVersion,
    });
  }
}

function stableHash(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) - h + input.charCodeAt(i)) | 0;
  }
  return h >>> 0; // unsigned 32-bit
}
