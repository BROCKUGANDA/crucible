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

/**
 * The digest a trial commits to for a piece of spec or suite content.
 *
 * `createTrial` accepts two `bytes32`s and stores them, and the seeds pass
 * `keccak256("spec-1")` — an ordinary keccak over the content bytes, not a hash of a
 * content id. That single fact is what makes already-running chains resolvable: the bytes
 * behind a digest do not have to be invented, only pinned and announced, because the
 * digest was computed from them.
 *
 * A sha256 content id cannot be derived from this value in the other direction, which is
 * why `@crucible/cidstore` keeps a disclosure log. This is the half that goes from the
 * bytes in hand to the number the chain already holds.
 *
 * Note the consequence for a seed that hashes `abi.encodePacked("spec-open", i,
 * block.timestamp)`: that digest has no content behind it by construction, and nothing
 * pinned later can ever match it. Content-addressing has to begin before the trial is
 * posted.
 */
export function digestOfContent(content: string | Uint8Array): Hex {
  return keccak256(typeof content === "string" ? stringToHex(content) : content);
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
 * The struct typehash this SDK's `RUN_TYPES` must produce, computed locally so a
 * mismatch is caught without a chain read. `CrucibleTrials.RUN_TYPEHASH` hashes the
 * same string; test/eip712-parity.test.ts parses that string out of the committed .sol
 * source and asserts the two agree — on the encode-type text, the field order, the
 * domain separator and the full digest — so neither side can drift silently and the
 * contract start rejecting every honest agent's signature with `BadSigner`.
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
