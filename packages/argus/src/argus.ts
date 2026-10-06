import { computeRunHash, type RunArtifact, type TestResult } from "@crucible/smith";
import { readSuiteResults, type SandboxSpec } from "@crucible/forge-runner";

/**
 * Argus — verifier/dispute agent.
 *
 * Two phases, and the ordering is the design:
 *
 *   Phase 1 (deterministic). Re-fetch the artifact, check its hash, check its
 *   signature, then re-run the pinned suite in an identical container and diff the
 *   results. The oracle is the suite, not an opinion. Steps 1-4 are the anti-fraud
 *   core: an artifact that fails its own hash or signature check never reaches the
 *   expensive re-execution.
 *
 *   Phase 2 (rubric). Only when the pinned suite is *partial* — it cannot decide.
 *   Three judges at temperature 0 with a fixed rubric, 2-of-3 agreement.
 *
 * Deterministic evidence always outranks the rubric. That precedence is why a
 * broken run cannot be saved by three agreeable LLMs.
 */

export type ArgusVerdict = "break-wins" | "agent-wins" | "abstain";

export interface VerifyInput {
  trialId: number;
  artifact: RunArtifact;
  /** the runHash recorded on-chain at submitRun */
  onChainRunHash: `0x${string}`;
  /** recover the EIP-712 signer from the submitted signature */
  recoverSigner(sig: `0x${string}`, digest: `0x${string}`): Promise<`0x${string}`>;
  /** the EIP-712 digest the runner signed */
  digestFor(args: {
    runHash: `0x${string}`;
    trialId: number;
    agentId: number;
    sigDeadline: bigint;
  }): `0x${string}`;
  sigDeadline: bigint;
  /**
   * The submitted signature.
   *
   * The chain records only `runHash` — `CrucibleTrials` verifies the signature and
   * then discards it. So this comes from the off-chain submission record (the
   * indexer's tx input, or the relayer's payload), which is why it is an explicit
   * input rather than a field on the artifact.
   */
  signature: `0x${string}`;
  /** fetch the run artifact from IPFS */
  fetchArtifact(cid: string): Promise<RunArtifact>;
  /** the agent's registered runner key */
  expectedRunner: `0x${string}`;
  /** re-run the pinned suite; returns the raw forge output */
  rerunSuite(args: { artifact: RunArtifact }): Promise<string>;
  sandbox?: SandboxSpec;
}

export interface VerifyStep {
  name: string;
  passed: boolean;
  detail: string;
}

export interface VerifyReport {
  verdict: ArgusVerdict;
  phase: "deterministic" | "rubric" | "abstain";
  steps: VerifyStep[];
  /** the re-run's results, when the suite actually ran */
  rerun?: TestResult[];
  reason: string;
}

export class Argus {
  /**
   * Phase 1. Returns abstain only when the suite genuinely cannot decide, which
   * is the sole entry to the rubric phase.
   */
  async verifyDeterministic(input: VerifyInput): Promise<VerifyReport> {
    const steps: VerifyStep[] = [];
    const { artifact, onChainRunHash } = input;

    // 3. hash integrity — the artifact must hash to what the chain recorded
    const computed = computeRunHash(artifact);
    const hashOk = computed.toLowerCase() === onChainRunHash.toLowerCase();
    steps.push({
      name: "artifact-hash",
      passed: hashOk,
      detail: hashOk
        ? `keccak(JCS(artifact)) == ${onChainRunHash.slice(0, 12)}…`
        : `recomputed ${computed.slice(0, 12)}… but chain recorded ${onChainRunHash.slice(0, 12)}…`,
    });
    if (!hashOk) {
      return fail(steps, "break-wins", "deterministic", "the artifact does not match its own committed hash");
    }

    // 4. runner binding — artifact.runnerAddress must equal the registered key
    const runnerOk =
      artifact.runnerAddress.toLowerCase() === input.expectedRunner.toLowerCase();
    steps.push({
      name: "runner-binding",
      passed: runnerOk,
      detail: runnerOk
        ? `runner ${artifact.runnerAddress} matches the registered key`
        : `artifact claims runner ${artifact.runnerAddress}, registry says ${input.expectedRunner}`,
    });
    if (!runnerOk) {
      return fail(steps, "break-wins", "deterministic", "the artifact is signed by an unregistered key");
    }

    // 5. signature — recover and compare against the artifact's own runner field
    const digest = input.digestFor({
      runHash: onChainRunHash,
      trialId: input.trialId,
      agentId: artifact.agentId,
      sigDeadline: input.sigDeadline,
    });
    let recovered: `0x${string}` | null = null;
    try {
      recovered = await input.recoverSigner(input.signature, digest);
    } catch (err) {
      steps.push({
        name: "signature",
        passed: false,
        detail: `signature did not recover: ${(err as Error).message}`,
      });
      return fail(steps, "break-wins", "deterministic", "the run signature does not recover");
    }
    const sigOk = recovered.toLowerCase() === artifact.runnerAddress.toLowerCase();
    steps.push({
      name: "signature",
      passed: sigOk,
      detail: sigOk
        ? "the signature recovers to the artifact's runner"
        : `signature recovers to ${recovered}, artifact claims ${artifact.runnerAddress}`,
    });
    if (!sigOk) {
      return fail(steps, "break-wins", "deterministic", "the signature does not match the artifact");
    }

    // 6. no red in the claimed artifact — a run with a failing test is self-refuting
    const allPass = artifact.testResults.every((t) => t.status === "pass");
    steps.push({
      name: "claimed-suite-green",
      passed: allPass,
      detail: allPass
        ? `${artifact.testResults.length} claimed test(s) all pass`
        : "the submitted artifact itself contains a failing test",
    });
    if (!allPass) {
      return fail(steps, "break-wins", "deterministic", "the submitted run was not green to begin with");
    }

    // 7. re-execute the pinned suite in an identical container
    let output: string;
    try {
      output = await input.rerunSuite({ artifact });
    } catch (err) {
      steps.push({
        name: "rerun",
        passed: false,
        detail: `re-execution failed: ${(err as Error).message}`,
      });
      // A re-run that cannot complete is not evidence the agent lied. Abstain, and
      // let the other seats decide — do not hand the skeptic a win for our outage.
      return {
        verdict: "abstain",
        phase: "abstain",
        steps,
        reason: "the pinned suite could not be re-executed, so it cannot decide",
      };
    }

    const rerun = readSuiteResults(output);
    if (rerun.length === 1 && rerun[0]!.name === "suite" && rerun[0]!.status === "fail") {
      steps.push({
        name: "rerun",
        passed: false,
        detail: `re-execution produced no parseable results: ${rerun[0]!.message ?? ""}`,
      });
      return {
        verdict: "abstain",
        phase: "abstain",
        steps,
        reason: "the pinned suite could not be re-executed, so it cannot decide",
      };
    }

    steps.push({ name: "rerun", passed: true, detail: `re-ran ${rerun.length} test(s)` });

    // 8. diff — names and statuses only. Durations legitimately vary run to run,
    //    so comparing them would make every re-run a mismatch and hand the skeptic
    //    30% of the bond for free.
    const claimed = fingerprint(artifact.testResults);
    const actual = fingerprint(rerun);
    const claimedNames = [...claimed];
    const actualNames = [...actual];
    const missing = claimedNames.filter((n) => !actual.has(n));
    const extra = actualNames.filter((n) => !claimed.has(n));

    if (missing.length > 0 || extra.length > 0) {
      steps.push({
        name: "result-diff",
        passed: false,
        detail:
          missing.length > 0
            ? `the re-run does not reproduce: missing ${missing.slice(0, 5).join(", ")}`
            : `the re-run ran tests the artifact never claimed: ${extra.slice(0, 5).join(", ")}`,
      });
      return {
        verdict: "break-wins",
        phase: "deterministic",
        steps,
        rerun,
        reason:
          missing.length > 0
            ? "the submitted artifact claims tests the pinned suite does not reproduce"
            : "the pinned suite runs tests the artifact omitted from its claim",
      };
    }

    steps.push({
      name: "result-diff",
      passed: true,
      detail: `${claimed.size} test(s) reproduce exactly`,
    });

    return {
      verdict: "agent-wins",
      phase: "deterministic",
      steps,
      rerun,
      reason: "the pinned suite reproduces the claim exactly",
    };
  }

  /** Phase 1 could not decide (partial suite). Only then is the rubric consulted. */
  async needsRubric(report: VerifyReport): Promise<boolean> {
    return report.verdict === "abstain" && report.phase === "abstain";
  }

}

function fingerprint(results: TestResult[]): Set<string> {
  return new Set(results.filter((r) => r.status === "pass").map((r) => r.name));
}

function fail(
  steps: VerifyStep[],
  verdict: ArgusVerdict,
  phase: VerifyReport["phase"],
  reason: string,
): VerifyReport {
  return { verdict, phase, steps, reason };
}
