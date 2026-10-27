import {
  ContentService,
  DEFAULT_SANDBOX,
  resolveVerifierImage,
  Sandbox,
  type FileTree,
  type SandboxSpec,
} from "@crucible/forge-runner";
import { RUN_PRIMARY_TYPE, RUN_TYPES, computeRunHash, domainFor, type RunArtifact } from "@crucible/smith";
import { hashTypedData, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { Argus, type VerifyInput, type VerifyReport } from "./argus.js";

/**
 * Argus, with its inputs supplied by the content layer instead of by a test.
 *
 * The deterministic verifier was written as a pure function over an injected
 * `VerifyInput` — good design, and the reason it looked finished. Nothing ever supplied
 * that input: `fetchArtifact` and `rerunSuite` were implemented only inside
 * `packages/argus/test/`, so the oracle ADR-0005 makes the centre of the product could not
 * run outside a unit test.
 *
 * This is the missing supplier. It resolves a run hash to the bytes the runner published,
 * rebuilds the digest the runner signed and recovers the signer from them rather than
 * trusting a digest handed to it, and re-executes the pinned suite on a fresh bench.
 */

/** Everything a caller must read from the chain before it can verify a run. */
export interface RunFacts {
  trialId: number;
  agentId: number;
  /** the `runHash` recorded by `submitRun` */
  runHash: Hex;
  /** the trial's own deadline for the run, from the packed timestamps word */
  sigDeadline: bigint;
  chainId: number;
  verifyingContract: Address;
  /**
   * The runner key the registry holds for this agent, read from the chain.
   *
   * Not taken from the artifact. The artifact already says which address signed it, and
   * checking that against itself would produce a green "runner-binding" gate on a run signed
   * by any key at all. The registry is the only thing that can say whether this agent is
   * allowed to claim work with that key.
   */
  runner: Address;
}

export interface LiveVerifierOptions {
  content: ContentService;
  /**
   * The bench to re-execute on. Defaults to the same image and caps the runner uses, so a
   * verifier re-runs the suite in the same envelope the work was done in — that identity is
   * the whole point of a deterministic re-run.
   */
  sandboxSpec?: SandboxSpec;
  /**
   * Bench factory, injectable for tests only.
   *
   * Named so a unit test can drive the wiring without a container runtime, and so it cannot
   * be confused with the thing it replaces: everything above this line — content resolution,
   * digest reconstruction, signature recovery, the result diff — runs for real either way.
   * Production never passes one.
   */
  makeBench?: (spec: SandboxSpec) => Promise<Pick<Sandbox, "repoDir" | "runSuite" | "writeFile" | "cleanup">>;
}

// Re-runs are the reproducibility claim, so this path honours the digest
// override: `CRUCIBLE_VERIFIER_IMAGE=crucible/verifier@sha256:…` pins the
// exact environment every re-run executes in.
const DEFAULT_SPEC: SandboxSpec = { ...DEFAULT_SANDBOX, image: resolveVerifierImage() };

export class LiveVerifier {
  private readonly argus = new Argus();
  private readonly spec: SandboxSpec;
  private readonly makeBench: NonNullable<LiveVerifierOptions["makeBench"]>;

  constructor(private readonly opts: LiveVerifierOptions) {
    this.spec = opts.sandboxSpec ?? DEFAULT_SPEC;
    this.makeBench =
      opts.makeBench ??
      (async (spec) => {
        const sandbox = await Sandbox.create(spec);
        return sandbox;
      });
  }

  /**
   * The digest the runner signed, rebuilt from the artifact and the trial facts.
   *
   * Recomputed rather than passed around because the field order and the domain are what a
   * forgery would have to get wrong. If a caller arrives here with a digest that does not
   * match this one, the disagreement is the finding, so `recoverSigner` refuses rather than
   * quietly using whichever number it was given.
   */
  digestFor(facts: RunFacts, artifact: RunArtifact): Hex {
    return hashTypedData({
      domain: domainFor(facts.verifyingContract, facts.chainId),
      primaryType: RUN_PRIMARY_TYPE,
      types: RUN_TYPES,
      message: {
        trialId: BigInt(facts.trialId),
        agentId: BigInt(artifact.agentId),
        runHash: facts.runHash,
        sigDeadline: facts.sigDeadline,
      },
    });
  }

  /**
   * Verify a run from its chain hash.
   *
   * Returns the report, not a boolean: the whole design rests on the difference between
   * "the agent lied", "the agent is telling the truth" and "I could not check", and
   * collapsing those three into two is how an outage becomes a false accusation.
   */
  async verify(facts: RunFacts): Promise<VerifyReport> {
    const record = await this.opts.content.recordForRun(facts.runHash);
    if (!record) {
      return {
        verdict: "abstain",
        phase: "abstain",
        steps: [
          {
            name: "disclosure",
            passed: false,
            detail: `no runner announced the bytes behind run hash ${facts.runHash.slice(0, 12)}…`,
          },
        ],
        reason: "the artifact was never published, so there is nothing to re-execute",
      };
    }

    const artifact = await this.opts.content.readArtifact<RunArtifact>(record.cid);
    const signature = (record.signature ?? "") as Hex;
    const sigDeadline = BigInt(record.sigDeadline ?? "0");
    const digest = this.digestFor(facts, artifact);

    const input: VerifyInput = {
      trialId: facts.trialId,
      artifact,
      onChainRunHash: facts.runHash,
      sigDeadline,
      signature,
      expectedRunner: facts.runner,
      fetchArtifact: async (cid) => this.opts.content.readArtifact<RunArtifact>(cid),
      digestFor: ({ runHash }) => {
        // The caller's digest must be the one this verifier reconstructs from the artifact,
        // or the recovery below would be answering a different question than the one asked.
        if (runHash.toLowerCase() !== facts.runHash.toLowerCase()) {
          throw new Error("digestFor was asked about a run hash other than this verification's");
        }
        return digest;
      },
      recoverSigner: async (sig, asked) => {
        if (asked.toLowerCase() !== digest.toLowerCase()) {
          throw new Error("the digest handed to recoverSigner is not the one this run hashes to");
        }
        return recoverTypedDataAddress({
          domain: domainFor(facts.verifyingContract, facts.chainId),
          primaryType: RUN_PRIMARY_TYPE,
          types: RUN_TYPES,
          message: {
            trialId: BigInt(facts.trialId),
            agentId: BigInt(artifact.agentId),
            runHash: facts.runHash,
            sigDeadline,
          },
          signature: sig,
        });
      },
      rerunSuite: async () => this.rerunOnFreshBench(artifact),
    };

    return this.argus.verifyDeterministic(input);
  }

  /**
   * Re-execute the pinned suite against the pinned repo, on a bench nobody has touched.
   *
   * Both halves come out of the store by content id, so the suite is the sponsor's and not
   * the one the agent liked, and the code is the bytes the run hash names. The bench is
   * thrown away afterwards; nothing about a previous run can leak into this one.
   */
  async rerunOnFreshBench(artifact: RunArtifact): Promise<string> {
    const bench = await this.makeBench(this.spec);
    try {
      await this.opts.content.fetchSuite(artifact.testsCID, bench);
      const repo = await this.opts.content.readArtifact<FileTree>(artifact.repoCID);
      for (const name of Object.keys(repo.files).sort()) {
        await bench.writeFile(name, repo.files[name]!);
      }
      const result = await bench.runSuite(artifact.suiteCommand, bench.repoDir);
      return result.stdout;
    } finally {
      await bench.cleanup();
    }
  }
}

/** Convenience for callers that already hold an artifact and want the hash the chain stores. */
export const runHashOf = computeRunHash;
