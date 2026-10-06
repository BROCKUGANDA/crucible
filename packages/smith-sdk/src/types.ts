/**
 * The canonical RunArtifact — the signed, pinned, falsifiable claim an agent makes
 * about a trial run. Mirrors crucible-contracts/docs/run-artifact.v1.json exactly.
 *
 * `runHash = keccak256(utf8(JCS(artifact)))` using RFC 8785 canonical JSON, so any
 * verifier (Argus, the frontend, a third party) recomputes byte-identical input.
 */

export const RUN_ARTIFACT_SCHEMA_VERSION = "1.0.0" as const;

export type TestStatus = "pass" | "fail" | "skip";

export interface TestResult {
  name: string;
  status: TestStatus;
  durationMs: number;
  message?: string;
}

/** CIDv0 (Qm…) or CIDv1 base32 (ba…). */
export type CID = string;

export interface RunArtifact {
  schemaVersion: typeof RUN_ARTIFACT_SCHEMA_VERSION;
  trialId: number;
  agentId: number;
  specCID: CID;
  testsCID: CID;
  repoCID: CID;
  commitSHA: string;
  suiteCommand: string;
  testResults: TestResult[];
  logsCID: CID;
  durationMs: number;
  model: string;
  startedAt: number;
  finishedAt: number;
  runnerAddress: `0x${string}`;
  chainId: number;
  verifyingContract: `0x${string}`;
}

export class RunArtifactError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
    this.name = "RunArtifactError";
  }
}

/**
 * CIDv0: "Qm" + 44 base58 chars = 46 total. Correct as specced.
 *
 * CIDv1: the spec's `ba[a-z2-7]{55}` is WRONG. A real CIDv1 is the multibase
 * base32 prefix "b" followed by base32(version ‖ codec ‖ multihash). For the
 * common case — raw codec (0x55) over a sha2-256 multihash — that is 36 bytes of
 * input, which encodes to 58 characters, for 59 total, and always begins "bafybei".
 * The specced pattern accepts 57 characters and so rejects every real CIDv1,
 * which would have made every artifact invalid.
 */
const CID_V0 = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const CID_V1 = /^b[a-z2-7]{58}$/;
const HEX40 = /^0x[a-fA-F0-9]{40}$/;
const GIT_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const MAX_TESTS = 10_000;

/**
 * Semantic validation, beyond the JSON Schema. Enforced pre-sign by the SDK so an
 * agent never burns a submission on a claim that a skeptic would trivially break.
 *
 * Rules 1-3 are local. Rules 4-6 need on-chain trial state and are checked by
 * `validateAgainstTrial`.
 */
function isCid(s: string): boolean {
  return CID_V0.test(s) || CID_V1.test(s);
}

/**
 * A commitment check that tolerates mixed representations: the artifact and the
 * indexer both speak CID text, while the chain speaks bytes32. If either side is
 * a digest we compare digests; if both are CID text we compare text. A digest and
 * a CID never compare equal, so the digest path is the authority.
 */
function matchesCommitment(
  artifactValue: string,
  contextValue: string,
  digest: `0x${string}`,
): boolean {
  if (artifactValue.toLowerCase() === digest.toLowerCase()) return true;
  return artifactValue === contextValue;
}

export function validateArtifact(a: RunArtifact): void {
  if (a.schemaVersion !== RUN_ARTIFACT_SCHEMA_VERSION) {
    throw new RunArtifactError(
      `schemaVersion must be ${RUN_ARTIFACT_SCHEMA_VERSION}`,
      "schemaVersion",
    );
  }
  for (const [field, cid] of [
    ["specCID", a.specCID],
    ["testsCID", a.testsCID],
    ["repoCID", a.repoCID],
    ["logsCID", a.logsCID],
  ] as const) {
    if (!CID_V0.test(cid) && !CID_V1.test(cid)) {
      throw new RunArtifactError(`not a valid IPFS CID: ${cid}`, field);
    }
  }
  if (!GIT_SHA.test(a.commitSHA)) {
    throw new RunArtifactError(`not a valid git SHA: ${a.commitSHA}`, "commitSHA");
  }
  if (!HEX40.test(a.runnerAddress)) {
    throw new RunArtifactError(`not an address: ${a.runnerAddress}`, "runnerAddress");
  }
  if (!HEX40.test(a.verifyingContract)) {
    throw new RunArtifactError(
      `not an address: ${a.verifyingContract}`,
      "verifyingContract",
    );
  }
  if (a.suiteCommand.length < 3 || a.suiteCommand.length > 300) {
    throw new RunArtifactError("suiteCommand must be 3-300 chars", "suiteCommand");
  }
  if (a.trialId < 1) throw new RunArtifactError("trialId must be >= 1", "trialId");
  if (a.agentId < 1) throw new RunArtifactError("agentId must be >= 1", "agentId");
  if (a.testResults.length < 1 || a.testResults.length > MAX_TESTS) {
    throw new RunArtifactError(
      `testResults must have 1-${MAX_TESTS} entries`,
      "testResults",
    );
  }
  for (const t of a.testResults) {
    if (t.name.length < 1 || t.name.length > 300) {
      throw new RunArtifactError("test name must be 1-300 chars", "testResults");
    }
    if (t.durationMs < 0) {
      throw new RunArtifactError("durationMs must be >= 0", "testResults");
    }
    if (t.message !== undefined && t.message.length > 2000) {
      throw new RunArtifactError("message must be <= 2000 chars", "testResults");
    }
  }
  // Rule 1: every result must pass. The contract would happily accept a red run; the
  // SDK refuses to, because submitting one is handing a skeptic free bond.
  if (a.testResults.some((t) => t.status !== "pass")) {
    const red = a.testResults.filter((t) => t.status !== "pass");
    throw new RunArtifactError(
      `forge-blocked: ${red.length} test(s) not passing (${red
        .slice(0, 3)
        .map((t) => `${t.name}:${t.status}`)
        .join(", ")})`,
      "testResults",
    );
  }
  // Rule 2: timing must be internally consistent.
  if (a.finishedAt <= a.startedAt) {
    throw new RunArtifactError("finishedAt must be > startedAt", "finishedAt");
  }
  if (a.durationMs !== a.finishedAt - a.startedAt) {
    throw new RunArtifactError(
      "durationMs must equal finishedAt - startedAt",
      "durationMs",
    );
  }
}

/** The slice of on-chain trial state needed to finish validation. */
export interface TrialContext {
  trialId: number;
  agentId: number;
  /** CID text from the indexer when available; otherwise the raw bytes32 commitment. */
  specCID: CID;
  testsCID: CID;
  /**
   * The on-chain bytes32 commitments. These are the values that must match, and
   * they work with or without an indexer. The CID fields above are for display and
   * for fetching content.
   */
  specDigest: `0x${string}`;
  testsDigest: `0x${string}`;
  createdAtMs: number;
  deadlineMs: number;
  /** the agent's registered runner key, from setRunner / registerAgent */
  runnerAddress: `0x${string}`;
  chainId: number;
  verifyingContract: `0x${string}`;
}

/** Semantic rules 2-6, which need on-chain state. */
export function validateAgainstTrial(a: RunArtifact, t: TrialContext): void {
  validateArtifact(a);
  if (a.trialId !== t.trialId) {
    throw new RunArtifactError("trialId does not match the trial", "trialId");
  }
  if (a.agentId !== t.agentId) {
    throw new RunArtifactError("agentId is not this trial's assigned agent", "agentId");
  }
  // Rules 6: the pinned content is fixed by the sponsor. Compare against the
  // indexer's CID text when we have it, and always against the on-chain digest —
  // the digest is what the trial actually commits to, and it is available with no
  // indexer. An agent cannot swap in its own suite and pass either check.
  if (isCid(a.specCID) && isCid(t.specCID) && a.specCID !== t.specCID) {
    throw new RunArtifactError(
      "specCID differs from the trial's pinned spec — an agent may not swap the spec",
      "specCID",
    );
  }
  if (isCid(a.testsCID) && isCid(t.testsCID) && a.testsCID !== t.testsCID) {
    throw new RunArtifactError(
      "testsCID differs from the trial's pinned suite — an agent may not swap the tests",
      "testsCID",
    );
  }
  const specOk = matchesCommitment(a.specCID, t.specCID, t.specDigest);
  if (!specOk) {
    throw new RunArtifactError(
      "specCID is not the trial's pinned spec — an agent may not swap the spec",
      "specCID",
    );
  }
  if (!matchesCommitment(a.testsCID, t.testsCID, t.testsDigest)) {
    throw new RunArtifactError(
      "testsCID is not the trial's pinned suite — an agent may not swap the tests",
      "testsCID",
    );
  }
  if (a.runnerAddress.toLowerCase() !== t.runnerAddress.toLowerCase()) {
    throw new RunArtifactError(
      "runnerAddress does not match the agent's registered runner key",
      "runnerAddress",
    );
  }
  if (a.chainId !== t.chainId) {
    throw new RunArtifactError(
      `artifact chainId ${a.chainId} != deployment chainId ${t.chainId}`,
      "chainId",
    );
  }
  if (a.verifyingContract.toLowerCase() !== t.verifyingContract.toLowerCase()) {
    throw new RunArtifactError(
      "verifyingContract is not this CrucibleTrials deployment",
      "verifyingContract",
    );
  }
  if (a.startedAt < t.createdAtMs) {
    throw new RunArtifactError("startedAt precedes the trial's creation", "startedAt");
  }
  if (a.finishedAt > t.deadlineMs) {
    throw new RunArtifactError("finishedAt is past the trial deadline", "finishedAt");
  }
}
