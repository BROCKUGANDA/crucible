/**
 * Gate 624 — Primitives table is law.
 *
 * The locked cryptographic stack. Drift between this table and code fails CI.
 * This module is the single crypto door (gate 625): every hash/encrypt/sign
 * call site routes through here, making it the PQC migration seam.
 */

export type Primitive = "keccak256" | "sha256" | "secp256k1" | "eip712" | "x25519" | "age" | "csprng" | "jcs" | "argon2id";

export interface PrimitiveEntry {
  primitive: Primitive;
  usedFor: string[];
  quantumImpact: string;
  verdict: string;
  pqcReady: boolean;
}

/** The locked primitives table. Generated from code annotations; drift fails CI. */
export const PRIMITIVES: PrimitiveEntry[] = [
  {
    primitive: "keccak256",
    usedFor: ["on-chain hashes", "promptHash", "span chain"],
    quantumImpact: "Grover: 256-bit -> 128-bit security",
    verdict: "fine, documented",
    pqcReady: false,
  },
  {
    primitive: "sha256",
    usedFor: ["off-chain content addressing", "files", "SBOMs"],
    quantumImpact: "Grover: 256-bit -> 128-bit security",
    verdict: "fine",
    pqcReady: false,
  },
  {
    primitive: "secp256k1",
    usedFor: ["wallet txs", "keeper EOA"],
    quantumImpact: "Shor breaks it",
    verdict: "chain-level, not ours to fix",
    pqcReady: false,
  },
  {
    primitive: "eip712",
    usedFor: ["structured operator approvals"],
    quantumImpact: "Shor",
    verdict: "same surface as txs",
    pqcReady: false,
  },
  {
    primitive: "x25519",
    usedFor: ["TLS 1.3 key exchange", "edge transport"],
    quantumImpact: "Shor breaks KEM",
    verdict: "hybrid path (ML-KEM-768 + X25519)",
    pqcReady: true,
  },
  {
    primitive: "age",
    usedFor: ["backups", "seeds at rest"],
    quantumImpact: "Shor breaks X25519",
    verdict: "hybrid path",
    pqcReady: true,
  },
  {
    primitive: "csprng",
    usedFor: ["keys", "nonces"],
    quantumImpact: "fine",
    verdict: "only source of randomness",
    pqcReady: true,
  },
  {
    primitive: "jcs",
    usedFor: ["canonical hash inputs", "claims", "verdicts", "span envelopes"],
    quantumImpact: "none",
    verdict: "locked suite already",
    pqcReady: true,
  },
  {
    primitive: "argon2id",
    usedFor: [],
    quantumImpact: "fine",
    verdict: "N/A — no passwords by design",
    pqcReady: true,
  },
];

/** Look up a primitive entry by name. */
export function getPrimitive(primitive: Primitive): PrimitiveEntry | undefined {
  return PRIMITIVES.find((p) => p.primitive === primitive);
}

/** Assert the primitives table is complete (no missing entries). */
export function assertPrimitivesComplete(primitives: Primitive[]): void {
  const missing = primitives.filter((p) => !PRIMITIVES.some((e) => e.primitive === p));
  if (missing.length > 0) {
    throw new Error(`primitives table missing entries: ${missing.join(", ")}`);
  }
}
