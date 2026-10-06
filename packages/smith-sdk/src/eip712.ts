import { keccak256, stringToHex, type Hex } from "viem";
import { canonicalize } from "json-canonicalize";
import { RUN_ARTIFACT_SCHEMA_VERSION, type RunArtifact } from "./types.js";

/**
 * The single true runHash: keccak256 over RFC 8785 canonical JSON.
 *
 * Every party — the agent that signs, Argus that re-verifies, the frontend that
 * displays, a third party auditing after the fact — must land on byte-identical
 * input. JCS guarantees that: keys sorted lexicographically by UTF-16 code unit,
 * no insignificant whitespace, ECMAScript Number::toString for numbers.
 *
 * All artifact strings are ASCII (CIDs, SHAs, model names), which keeps JCS
 * implementations from diverging on Unicode normalisation.
 */
export function canonicalizeArtifact(artifact: RunArtifact): string {
  return canonicalize(artifact);
}

export function computeRunHash(artifact: RunArtifact): Hex {
  return keccak256(stringToHex(canonicalizeArtifact(artifact)));
}

/** ~10 minutes. Bounds the damage from a leaked signature. */
export const SIG_DEADLINE_TTL_SECONDS = 600;

export function computeSigDeadline(nowSeconds = Math.floor(Date.now() / 1000)): bigint {
  return BigInt(nowSeconds + SIG_DEADLINE_TTL_SECONDS);
}

export interface Eip712Domain {
  name: "Crucible";
  version: "1";
  chainId: number;
  verifyingContract: `0x${string}`;
}

/**
 * Must match CrucibleTrials.RUN_TYPEHASH exactly:
 *   keccak256("Run(uint256 trialId,uint256 agentId,bytes32 runHash,uint64 sigDeadline)")
 */
export const RUN_TYPES = {
  Run: [
    { name: "trialId", type: "uint256" },
    { name: "agentId", type: "uint256" },
    { name: "runHash", type: "bytes32" },
    { name: "sigDeadline", type: "uint64" },
  ],
} as const;

export const RUN_PRIMARY_TYPE = "Run" as const;

/**
 * The struct typehash this SDK's `types` must produce, computed locally so a
 * mismatch is caught without a chain read. The contract asserts the same string
 * in CrucibleTrials.RUN_TYPEHASH; test/abi-parity.test.ts checks the two agree
 * against a real deployment, so neither side can drift silently.
 */
export const RUN_TYPEHASH = keccak256(
  stringToHex("Run(uint256 trialId,uint256 agentId,bytes32 runHash,uint64 sigDeadline)"),
);

export const DOMAIN_TYPEHASH = keccak256(
  stringToHex(
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
  ),
);

export function domainFor(trialsAddress: `0x${string}`, chainId: number): Eip712Domain {
  return { name: "Crucible", version: "1", chainId, verifyingContract: trialsAddress };
}

export interface RunMessage {
  trialId: bigint;
  agentId: bigint;
  runHash: Hex;
  sigDeadline: bigint;
}

export function runMessage(args: {
  trialId: number | bigint;
  agentId: number | bigint;
  runHash: Hex;
  sigDeadline: bigint;
}): RunMessage {
  return {
    trialId: BigInt(args.trialId),
    agentId: BigInt(args.agentId),
    runHash: args.runHash,
    sigDeadline: args.sigDeadline,
  };
}

/** The sigDeadline is fresh per submission; reusing a stale one reverts SigExpired. */
export function freshSubmission(args: {
  artifact: RunArtifact;
  agentId: number | bigint;
  nowSeconds?: number;
}): { runHash: Hex; sigDeadline: bigint } {
  return {
    runHash: computeRunHash(args.artifact),
    sigDeadline: computeSigDeadline(args.nowSeconds),
  };
}

export { RUN_ARTIFACT_SCHEMA_VERSION };
