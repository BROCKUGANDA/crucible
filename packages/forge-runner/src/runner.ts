import {
  buildArtifact,
  computeRunHash,
  parseForgeTests,
  summarise,
  validateArtifact,
  type RunArtifact,
  type SmithAgent,
  type TestResult,
  type TrialBrief,
  type WorkContext,
  type WorkResult,
} from "@crucible/smith";
import { Sandbox, SandboxUnavailable, DEFAULT_SANDBOX, type SandboxSpec } from "./sandbox.js";
import {
  FAILURE_COPY,
  ForgeFailure,
  classify,
  consoleSink,
  suiteLine,
  type StatusEvent,
  type StatusSink,
  type ForgeStatus,
} from "./status.js";

/**
 * ForgeRunner — the work-performing agent.
 *
 * The loop from the PRD: fetch spec → plan → implement → run the pinned suite →
 * iterate within budget → emit a signed artifact. Two invariants matter more than
 * the loop itself:
 *
 *   1. All-or-nothing. A run either produces a fully-formed artifact that
 *      validates, or it produces nothing. There is no partial submit.
 *   2. Never submit red. If the suite is still failing when the budget runs out,
 *      the run fails with suite-fails-budget. Submitting a red artifact would
 *      hand a skeptic 30% of the bond for free.
 */

export interface RunnerDeps {
  agent: SmithAgent;
  sandbox?: SandboxSpec;
  /** fetch the trial spec text from IPFS */
  fetchSpec(cid: string): Promise<string>;
  /** fetch the trial's pinned suite into the sandbox; returns the commit SHA */
  fetchSuite(cid: string, sandbox: Sandbox): Promise<string>;
  /** pin the run logs; returns the CID */
  uploadLogs(contents: string): Promise<string>;
  /** pin the agent's work; returns the CID */
  uploadRepo(sandbox: Sandbox): Promise<string>;
  /** sign with the runner key */
  sign(args: {
    runHash: `0x${string}`;
    trialId: number;
    agentId: number;
    sigDeadline: bigint;
  }): Promise<`0x${string}`>;
  /** submit on-chain; any relayer may send it */
  submit(args: {
    runHash: `0x${string}`;
    sig: `0x${string}`;
    sigDeadline: bigint;
  }): Promise<`0x${string}`>;
  runnerAddress: `0x${string}`;
  chainId: number;
  verifyingContract: `0x${string}`;
  model: string;
  status?: StatusSink;
}

export interface RunRequest {
  trialId: number;
  agentId: number;
  specCID: string;
  testsCID: string;
  suiteCommand: string;
  timeBudgetSec: number;
  iterBudget: number;
  /** the trial's bond in wei — checked against the operator's cap before any work */
  bondWei: bigint;
  /** absolute deadline, unix ms — the trial's own, not a fresh budget */
  deadlineMs: number;
}

export interface RunOutcome {
  ok: boolean;
  status: ForgeStatus;
  artifact?: RunArtifact;
  runHash?: `0x${string}`;
  txHash?: `0x${string}`;
  iterations: number;
  summary?: ReturnType<typeof summarise>;
  /** true when execution was NOT containerised */
  degraded: boolean;
  failure?: ForgeFailure;
}

/** Mutable per-run state. Scoped to one run() call — never module-level. */
interface RunState {
  iterations: number;
  parsed: TestResult[];
  lastOutput?: string;
  degraded: boolean;
}

export class ForgeRunner {
  constructor(private readonly deps: RunnerDeps) {}

  async run(req: RunRequest): Promise<RunOutcome> {
    const sink = this.deps.status ?? consoleSink();
    const emit = (
      status: ForgeStatus,
      label: string,
      extra: Partial<Omit<StatusEvent, "status" | "label" | "at">> = {},
    ) => sink({ status, label, at: Date.now(), ...extra });

    const state: RunState = { iterations: 0, parsed: [], degraded: false };
    let sandbox: Sandbox | null = null;

    try {
      this.assertWithinBudget(req);
      this.assertBeforeDeadline(req);

      emit("quenching-spec", `quenching spec ${short(req.specCID)}`);
      const specText = await this.fetchSpecOrFail(req.specCID);

      sandbox = await this.openSandbox();
      state.degraded = sandbox.degraded;
      if (sandbox.degraded) {
        // Say it out loud. A silent fallback would produce an artifact claiming
        // sandboxed execution it never had — exactly what a skeptic is paid to break.
        emit("forging", "⚠ no Docker: running unisolated (artifact marked degraded)");
      }
      await sandbox.writeSpec(specText);
      const commitSHA = await this.deps.fetchSuite(req.testsCID, sandbox);
      const suiteRepoCID = await this.tryPin(() => this.deps.uploadRepo(sandbox!));
      const logsCID = await this.tryPin(() => this.deps.uploadLogs(state.lastOutput ?? ""));

      const startedAt = Date.now();
      emit("planning", `planning — ${this.deps.model}`);

      const brief = this.briefFor(req);

      while (state.iterations < req.iterBudget) {
        this.assertBeforeDeadline(req);
        state.iterations += 1;
        emit("forging", `iter ${state.iterations}/${req.iterBudget} — forging`, {
          iteration: state.iterations,
          maxIterations: req.iterBudget,
        });

        const ctx: WorkContext = {
          brief,
          iteration: state.iterations,
          lastOutput: state.lastOutput,
        };

        const step = await this.runAgentStep(ctx);
        await this.applyStep(sandbox, step);

        // run the pinned suite
        emit("suite-running", "suite loaded — pinned", {
          iteration: state.iterations,
          maxIterations: req.iterBudget,
        });
        const suite = await sandbox.runSuite(req.suiteCommand);
        state.lastOutput = `${suite.stdout}\n${suite.stderr}`.trim();
        state.parsed = readSuiteResults(state.lastOutput);

        const results = summarise(state.parsed);
        emit(
          results.green ? "green" : "red",
          suiteLine(state.iterations, req.iterBudget, results.passed, results.failed),
          {
            iteration: state.iterations,
            maxIterations: req.iterBudget,
            passed: results.passed,
            failed: results.failed,
          },
        );

        if (results.green && step.done) break;
      }

      const results = summarise(state.parsed);
      if (!results.green) {
        throw new ForgeFailure(
          "suite-fails-budget",
          `Out of iterations with ${results.failed} test(s) still red. Restrike or walk away.`,
        );
      }
      if (results.total === 0) {
        throw new ForgeFailure(
          "artifact-invalid",
          "The pinned suite reported no tests, so there is nothing to claim.",
        );
      }

      const artifact = buildArtifact({
        trialId: req.trialId,
        agentId: req.agentId,
        specCID: req.specCID,
        testsCID: req.testsCID,
        repoCID: suiteRepoCID || req.testsCID,
        commitSHA,
        suiteCommand: req.suiteCommand,
        testResults: state.parsed,
        logsCID: logsCID || req.specCID,
        model: this.deps.model,
        startedAt,
        finishedAt: Date.now(),
        runnerAddress: this.deps.runnerAddress,
        chainId: this.deps.chainId,
        verifyingContract: this.deps.verifyingContract,
      });

      try {
        validateArtifact(artifact);
      } catch (err) {
        throw new ForgeFailure("artifact-invalid", FAILURE_COPY["artifact-invalid"], err);
      }

      const runHash = computeRunHash(artifact);
      const sigDeadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      const sig = await this.deps.sign({
        runHash,
        trialId: req.trialId,
        agentId: req.agentId,
        sigDeadline,
      });

      emit("signed", `✓ ${results.label} — signing artifact`);
      await this.deps.agent.hooks?.onSubmit?.(artifact);

      const txHash = await this.deps.submit({ runHash, sig, sigDeadline });
      emit("submitted", "Work presented. Skeptics, do your worst.");

      return {
        ok: true,
        status: "submitted",
        artifact,
        runHash,
        txHash,
        iterations: state.iterations,
        summary: results,
        degraded: state.degraded,
      };
    } catch (err) {
      const failure = classify(err);
      emit("failed", failure.message);
      await this.deps.agent.hooks?.onRefusal?.(failure.message, this.briefFor(req));
      return {
        ok: false,
        status: "failed",
        iterations: state.iterations,
        degraded: state.degraded,
        failure,
      };
    } finally {
      await sandbox?.cleanup();
    }
  }

  // ── internals ──────────────────────────────────────────────────────────
  private briefFor(req: RunRequest): TrialBrief {
    return {
      trialId: req.trialId,
      agentId: req.agentId,
      specCID: req.specCID,
      testsCID: req.testsCID,
      timeBudgetSec: req.timeBudgetSec,
      iterBudget: req.iterBudget,
      gasPolicy: {
        maxIterations: req.iterBudget,
        maxWallClockSec: req.timeBudgetSec,
        maxBondWei: req.bondWei,
      },
    };
  }

  private assertWithinBudget(req: RunRequest): void {
    // The cap check lives in the caller (Smith's RiskCapExceeded); here we only
    // assert the request is internally coherent.
    if (req.iterBudget < 1) throw new ForgeFailure("suite-fails-budget", "iterBudget must be >= 1");
    if (req.bondWei < 0n) throw new ForgeFailure("bond-over-cap", FAILURE_COPY["bond-over-cap"]);
  }

  private assertBeforeDeadline(req: RunRequest): void {
    if (Date.now() > req.deadlineMs) {
      throw new ForgeFailure("deadline-exceeded", FAILURE_COPY["deadline-exceeded"]);
    }
  }

  private async fetchSpecOrFail(cid: string): Promise<string> {
    let text: string;
    try {
      text = await this.deps.fetchSpec(cid);
    } catch (err) {
      throw new ForgeFailure("spec-unfetchable", FAILURE_COPY["spec-unfetchable"], err);
    }
    if (text.trim().length === 0) {
      throw new ForgeFailure("spec-unfetchable", "The pinned spec is empty.");
    }
    return text;
  }

  private async openSandbox(): Promise<Sandbox> {
    try {
      return await Sandbox.create(this.deps.sandbox ?? DEFAULT_SANDBOX);
    } catch (err) {
      if (err instanceof SandboxUnavailable) {
        throw new ForgeFailure("sandbox-unavailable", err.message, err);
      }
      throw classify(err);
    }
  }

  private async runAgentStep(ctx: WorkContext): Promise<WorkResult> {
    try {
      await this.deps.agent.hooks?.onTrialLoaded?.(ctx);
      const step = await this.deps.agent.step(ctx);
      await this.deps.agent.hooks?.onIteration?.(ctx, step);
      return step;
    } catch (err) {
      throw classify(err);
    }
  }

  /** A patch that fails to apply is a normal iteration outcome, not a crash. */
  private async applyStep(sandbox: Sandbox, step: WorkResult): Promise<void> {
    if (step.patch.trim().length === 0) return;
    const applied = await sandbox.applyPatch(step.patch);
    if (!applied.ok) {
      throw new ForgeFailure(
        "agent-threw",
        `The agent produced a patch that would not apply: ${applied.message}`,
      );
    }
  }

  private async tryPin(fn: () => Promise<string>): Promise<string> {
    try {
      return await fn();
    } catch {
      // A failed pin degrades the artifact's verifiability but must not lose the
      // run: the caller falls back to the spec CID and the failure is visible in
      // the artifact because logsCID/repoCID will not match the real content.
      return "";
    }
  }
}

/**
 * Read the suite's own JSON out of combined stdout+stderr. forge writes JSON on
 * stdout but compiler chatter can precede it, so we slice the outermost braces.
 * Never throws: a suite that printed no JSON is a red suite, not a crash.
 */
export function readSuiteResults(output: string): TestResult[] {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return parseForgeTests(output.slice(start, end + 1));
    } catch {
      /* fall through to the synthetic failure below */
    }
  }
  const first = output.split("\n").find((l) => l.trim().length > 0)?.slice(0, 2000);
  return [
    {
      name: "suite",
      status: "fail",
      durationMs: 0,
      message: first ?? "the suite produced no parseable output",
    },
  ];
}

function short(cid: string): string {
  return cid.length <= 14 ? cid : `${cid.slice(0, 10)}…`;
}
