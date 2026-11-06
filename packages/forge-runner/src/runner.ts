import { tmpdir } from "node:os";
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
import { touchesTests } from "./agent.js";
import { emitManifest, type EmittedManifest, type ManifestInputs } from "./manifest.js";
import {
  Sandbox,
  SandboxUnavailable,
  DEFAULT_SANDBOX,
  reapContainers,
  runningSandboxLabels,
  reapWorkspaces,
  resolveVerifierImage,
  type SandboxDeps,
  type SandboxSpec,
} from "./sandbox.js";
import { strictSandboxFor, type TrialTier } from "./tiers.js";
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
import {
  ForgeWatchEventType,
  type ForgeWatchEvent,
} from "@crucible/forge-watch";

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
  /**
   * Publish the evaluation manifest beside the run and announce it for its hash.
   *
   * Optional, because a host that has no content volume has nothing to publish to — but a host
   * that does should not have to remember. `ManifestPublisher` in `manifest-publisher.js` is
   * the implementation; a run whose manifest was never published can be re-derived from its
   * artifact by anyone holding the same inputs, which is the point of pinning it.
   */
  publishManifest?(args: {
    runHash: `0x${string}`;
    manifest: EmittedManifest["manifest"];
  }): Promise<{ cid: string; digest: `0x${string}` }>;
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
  /**
   * The Docker-CLI seam passed to `Sandbox.create`.
   *
   * For tests, which have no daemon and no verifier image on every machine, and for an
   * operator who wants the probe and the digest inspection to run through something other
   * than the `docker` on PATH. Production leaves it undefined and gets the real CLI.
   */
  sandboxDeps?: SandboxDeps;
  /**
   * Pre-flight orphan hygiene, called once per run before the sandbox is opened.
   *
   * The default shells out to Docker and scans the system temp dir for wreckage
   * earlier runs left behind. Tests replace it: unit suites run beside parallel
   * sandbox tests whose containers must never be targets, and no unit test should
   * touch a real daemon to prove a green. Returning zero counts is the no-op.
   */
  reap?: () => Promise<[containers: number, workspaces: number]>;
  /**
   * The evaluation's own inputs, for the manifest.
   *
   * Optional, because a caller that knows only the model can still run - it
   * will produce a sparse manifest, and its absent fields will read as
   * absent rather than as a guess. What is NOT optional is that the manifest
   * is emitted at all: a score nobody can attribute is not evidence.
   */
  manifest?: Omit<ManifestInputs, "model" | "specDigest" | "suiteDigest">;
  status?: StatusSink;
  /**
   * Trusted tenant identity supplied by the execution host. Never read this
   * value from an agent payload or an untrusted request body.
   */
  tenantId?: string;
  /**
   * Optional telemetry emitter for Forge Watch. The runner calls it with a
   * canonical envelope at each execution boundary; the host wires it to the
   * TelemetryCollector. The runner never imports the collector itself, so the
   * monitor stays outside the agent's execution boundary.
   */
  emitEvent?(event: ForgeWatchEvent): void | Promise<void>;
}

export interface RunRequest {
  trialId: number;
  agentId: number;
  specCID: string;
  testsCID: string;
  /**
   * The trial's on-chain commitments, for the manifest.
   *
   * These are the `bytes32` values the chain holds, not the CIDs. The
   * distinction matters: a CID names content by a content-address, and the
   * chain holds a keccak digest of the same bytes. The manifest records what
   * the chain committed to, because that is what a third party can check.
   */
  specDigest?: `0x${string}`;
  suiteDigest?: `0x${string}`;
  suiteCommand: string;
  timeBudgetSec: number;
  iterBudget: number;
  /** the trial's bond in wei - checked against the operator's cap before any work */
  bondWei: bigint;
  /** the trial classification (gates 841-842): raises the sandbox floor for this run */
  tier?: TrialTier;
  /** absolute deadline, unix ms - the trial's own, not a fresh budget */
  deadlineMs: number;
}

export interface RunOutcome {
  ok: boolean;
  status: ForgeStatus;
  /** Unique execution identity, distinct from the reusable trial identifier. */
  runId: string;
  /** Delivery result for instrumented runtime events, not an Argus verdict. */
  telemetry: {
    status: "complete" | "partial" | "unavailable";
    emitted: number;
    failed: number;
  };
  artifact?: RunArtifact;
  runHash?: `0x${string}`;
  txHash?: `0x${string}`;
  iterations: number;
  summary?: ReturnType<typeof summarise>;
  /** true when execution was NOT containerised */
  degraded: boolean;
  failure?: ForgeFailure;
  /**
   * The manifest and its digest, when the run produced one.
   *
   * It travels with the outcome and is published beside the artifact. It is
   * NOT signed and NOT on chain: the manifest is a fact about the evaluation,
   * derived from inputs that are themselves content-addressed, so nobody
   * needs to vouch for it (ADR-0017).
   */
  manifest?: EmittedManifest;
  /**
   * What `publishManifest` returned, when there was a host to publish to.
   *
   * `null` means it was tried and refused, `undefined` means there was nothing to try (no
   * publisher, or no manifest to publish). Those are different operational facts and an
   * operator reading this must be able to tell them apart.
   */
  manifestPublished?: { cid: string; digest: `0x${string}` } | null;
}

/**
 * Files offered to the agent as patch context.
 *
 * Fixed and small on purpose. Handing an agent a whole repository tree would blow the
 * context window and, worse, would include the pinned suite it is told not to touch.
 * The trial's own layout decides the real list; these are the defaults.
 */
const EDITABLE_GLOBS = ["src/Forge.sol"] as const;

/** Mutable per-run state. Scoped to one run() call — never module-level. */
interface RunState {
  iterations: number;
  parsed: TestResult[];
  lastOutput?: string;
  degraded: boolean;
  /**
   * The immutable image reference the container launched from, read off the sandbox that
   * ran the work. `undefined` whenever `degraded` is true — there is no container, so there
   * is no image to name, and the manifest says so instead of quoting the tag.
   */
  imageDigest?: string;
  /** The spec the sandbox was created from, after any tier raising. */
  sandboxSpec?: SandboxSpec;
}

export class ForgeRunner {
  constructor(private readonly deps: RunnerDeps) {}

  async run(req: RunRequest): Promise<RunOutcome> {
    const runId = crypto.randomUUID();
    let nextEventSequence = 1;
    let telemetryEmitted = 0;
    let telemetryFailed = 0;
    const configuredEmitter = typeof this.deps.emitEvent === "function";
    const telemetrySummary = (): RunOutcome["telemetry"] => ({
      status: !configuredEmitter
        ? "unavailable"
        : telemetryFailed > 0 || telemetryEmitted === 0
          ? "partial"
          : "complete",
      emitted: telemetryEmitted,
      failed: telemetryFailed,
    });
    const watch = async (
      event: Partial<Omit<ForgeWatchEvent, "runId" | "trialId" | "agentId" | "tenantId" | "sequence">> & {
        eventType: ForgeWatchEvent["eventType"];
      },
    ): Promise<void> => {
      const emitEvent = this.deps.emitEvent;
      if (!emitEvent) return;
      const envelope: ForgeWatchEvent = {
        ...event,
        schemaVersion: 1,
        timestamp: Date.now(),
        eventId: crypto.randomUUID(),
        sequence: nextEventSequence++,
        runId,
        trialId: String(req.trialId),
        agentId: String(req.agentId),
        tenantId: this.deps.tenantId ?? "default",
        source: "forge-runner",
      };
      try {
        await emitEvent(envelope);
        telemetryEmitted += 1;
      } catch {
        // Monitoring is outside the agent's control and must not crash execution.
        // The failure remains visible on RunOutcome.telemetry and blocks a
        // downstream "runtime complete" classification.
        telemetryFailed += 1;
      }
    };
    const sink = this.deps.status ?? consoleSink();
    const emit = (
      status: ForgeStatus,
      label: string,
      extra: Partial<Omit<StatusEvent, "status" | "label" | "at">> = {},
    ) => sink({ status, label, at: Date.now(), ...extra });

    const state: RunState = { iterations: 0, parsed: [], degraded: false };
    const runLog: string[] = [];
    let sandbox: Sandbox | null = null;

    try {
      this.assertWithinBudget(req);
      this.assertBeforeDeadline(req);

      emit("quenching-spec", `quenching spec ${short(req.specCID)}`);
      const specText = await this.fetchSpecOrFail(req.specCID);

      // Orphan hygiene before a sandbox is opened, best-effort and never gating: a
      // reaper that cannot run (no daemon yet, unreadable temp dir) says nothing
      // about whether this run can execute, so its failures are swallowed here by
      // design. What it clears is residue from earlier runs — containers whose
      // exit-time removal failed, temp workspaces a dead process left behind — and
      // it only touches containers that are no longer running and workspaces
      // nothing has touched in over a day, so a concurrent live run is never a
      // target.
      const reap = this.deps.reap ?? (async () => [
        await reapContainers().catch(() => 0),
        // Workspace reaping consults the daemon first: a workspace a running
        // container still occupies is live ownership, not stale mtime.
        await runningSandboxLabels()
          .then((live) => reapWorkspaces(86_400_000, tmpdir(), live))
          .catch(() => 0),
      ] as [number, number]);
      const [orphanContainers, orphanWorkspaces] = await reap();
      if (orphanContainers + orphanWorkspaces > 0) {
        emit(
          "quenching-spec",
          `pre-flight: reaped ${orphanContainers} orphaned container(s), ` +
            `${orphanWorkspaces} stale workspace(s)`,
        );
      }

      sandbox = await this.openSandbox(req);
      state.degraded = sandbox.degraded;
      state.imageDigest = sandbox.imageDigest;
      state.sandboxSpec = sandbox.spec;
      await watch({
        eventType: ForgeWatchEventType.containerCreate,
        environmentId: sandbox.degraded ? "degraded" : "sandbox",
      });
      if (sandbox.degraded) {
        // Say it out loud. A silent fallback would produce an artifact claiming
        // sandboxed execution it never had — exactly what a skeptic is paid to break.
        // Saying it out loud is not enough on its own, which is why the same fact is
        // written into the manifest the run emits (`environment.isolation`); a status
        // line is gone by the time a skeptic reads the record.
        emit("forging", "⚠ no Docker: running unisolated (artifact marked degraded)");
      }
      await sandbox.writeSpec(specText);
      const commitSHA = await this.deps.fetchSuite(req.testsCID, sandbox);

      const startedAt = Date.now();
      emit("planning", `planning — ${this.deps.model}`);

      const brief = this.briefFor(req);

      while (state.iterations < req.iterBudget) {
        this.assertBeforeDeadline(req);
        state.iterations += 1;
        await watch({
          eventType: ForgeWatchEventType.agentTurnStart,
          correlationId: String(state.iterations),
        });
        emit("forging", `iter ${state.iterations}/${req.iterBudget} — forging`, {
          iteration: state.iterations,
          maxIterations: req.iterBudget,
        });

        const ctx: WorkContext = {
          brief,
          iteration: state.iterations,
          lastOutput: state.lastOutput,
          spec: specText,
          files: await this.collectEditableFiles(sandbox),
        };

        const step = await this.runAgentStep(ctx);
        await watch({
          eventType: ForgeWatchEventType.toolCallCreate,
          toolId: "plan",
          correlationId: String(state.iterations),
        });
        if (step.withheld?.suiteOutput) {
          // Say it out loud: the agent wrote this iteration's patch without the previous
          // suite output. The label names the cause and carries none of the withheld text.
          emit(
            "forging",
            "suite output withheld — it matched a retrieved-content injection pattern",
            {
              iteration: state.iterations,
              maxIterations: req.iterBudget,
              withheld: "suite-output",
            },
          );
        }
        await watch({
          eventType: ForgeWatchEventType.toolCallExecute,
          toolId: "apply_patch",
          correlationId: String(state.iterations),
        });
        await this.applyStep(sandbox, step);

        // run the pinned suite
        await watch({
          eventType: ForgeWatchEventType.graderExecution,
          correlationId: String(state.iterations),
        });
        emit("suite-running", "suite loaded — pinned", {
          iteration: state.iterations,
          maxIterations: req.iterBudget,
        });
        const suite = await sandbox.runSuite(req.suiteCommand);
        await watch({
          eventType: ForgeWatchEventType.toolCallOutput,
          toolId: "run_suite",
          correlationId: String(state.iterations),
        });
        state.lastOutput = `${suite.stdout}\n${suite.stderr}`.trim();
        state.parsed = readSuiteResults(state.lastOutput);
        // Every iteration, not the last one. `state.lastOutput` is overwritten each pass and
        // feeds the agent's next prompt; this is the record a skeptic fetches, and output
        // withheld from the agent still belongs in it.
        runLog.push(`# iteration ${state.iterations}\n${state.lastOutput}`);

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

      // Both pins come after the loop. A skeptic's re-run overlays `repoCID`'s files onto a
      // fresh bench holding the sponsor's suite (`packages/argus/src/live.ts:184`), so a repo
      // pinned before the agent wrote anything re-runs the exam with no answer in it and
      // reports a verification that verified nothing. Pinning only on the green path also
      // means a run that throws never pays for a pin nobody will read.
      const repoCID = await this.tryPin(() => this.deps.uploadRepo(sandbox!));
      const logsCID = await this.tryPin(() => this.deps.uploadLogs(runLog.join("\n")));

      const artifact = buildArtifact({
        trialId: req.trialId,
        agentId: req.agentId,
        specCID: req.specCID,
        testsCID: req.testsCID,
        repoCID: repoCID || req.testsCID,
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

      // The manifest is emitted LAST, on the green path only, and it is
      // emitted from the run's own inputs rather than derived from the
      // artifact - the artifact is a fact about the run, and this is a fact
      // about the evaluation.
      //
      // A run that throws produces no manifest, exactly as it produces no
      // artifact: there is no score to attribute, so there is nothing for a
      // manifest to describe.
      const manifest = this.emitManifestFor(req, startedAt, Date.now(), state);

      /**
       * Publish the manifest, and say so either way.
       *
       * A published manifest is evidence, not a receipt: the run is already on chain, so a
       * failure here must not rewrite an outcome the caller has acted on, must not un-submit
       * anything, and must not be caught-and-forgotten. It is announced on the status stream
       * and carried in the outcome, because a run whose manifest never landed is a score whose
       * conditions nobody can re-derive — the kind of gap a silent `catch {}` turns permanent.
       */
      let manifestPublished: { cid: string; digest: `0x${string}` } | null | undefined;
      if (this.deps.publishManifest && manifest) {
        try {
          manifestPublished = await this.deps.publishManifest({ runHash, manifest: manifest.manifest });
          emit("manifest-published", `evaluation manifest pinned as ${manifestPublished.cid}`);
        } catch (err) {
          manifestPublished = null;
          emit(
            "manifest-unpublished",
            `the run is on chain, but its evaluation manifest was not published: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      return {
        ok: true,
        status: "submitted",
        runId,
        telemetry: telemetrySummary(),
        artifact,
        runHash,
        txHash,
        iterations: state.iterations,
        summary: results,
        degraded: state.degraded,
        manifest,
        manifestPublished,
      };
    } catch (err) {
      const failure = classify(err);
      emit("failed", failure.message);
      await this.deps.agent.hooks?.onRefusal?.(failure.message, this.briefFor(req));
      return {
        ok: false,
        status: "failed",
        runId,
        telemetry: telemetrySummary(),
        iterations: state.iterations,
        degraded: state.degraded,
        failure,
      };
    } finally {
      await sandbox?.cleanup();
    }
  }

  // ── internals ──────────────────────────────────────────────────────────
  /**
   * Emit the manifest for a run.
   *
   * It is built from the operator's inputs plus the run's own environment, and
   * it is returned rather than published here: publishing it is the caller's
   * job, because only the caller knows the content store the manifest should
   * land in.
   *
   * **A run with no digests and no evaluator inputs produces no manifest.**
   * That is not a fallback path - it is a refusal to invent a task digest or
   * a rubric version. A manifest whose `taskDigest` was a placeholder would
   * be indistinguishable, to every consumer, from one that knew the value.
   */
  private emitManifestFor(
    req: RunRequest,
    startedAt: number,
    finishedAt: number,
    state: Pick<RunState, "degraded" | "imageDigest" | "sandboxSpec">,
  ): EmittedManifest | undefined {
    const inputs = this.deps.manifest;
    if (!inputs || !req.specDigest || !req.suiteDigest) return undefined;
    return emitManifest(
      {
        ...inputs,
        specDigest: req.specDigest,
        suiteDigest: req.suiteDigest,
        model: this.deps.model,
      },
      {
        // The spec the sandbox was *built* from, not the one the caller passed in: a tier
        // raises the floor (`strictSandboxFor`), and a manifest that recorded the un-raised
        // limits would understate what the run actually ran under.
        sandbox:
          state.sandboxSpec ??
          this.deps.sandbox ?? { ...DEFAULT_SANDBOX, image: resolveVerifierImage() },
        imageDigest: state.imageDigest,
        tier: req.tier,
        timeoutMs: req.timeBudgetSec * 1000,
        degraded: state.degraded,
      },
      new Date(startedAt).toISOString(),
      new Date(finishedAt).toISOString(),
    );
  }

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

  private async openSandbox(req: RunRequest): Promise<Sandbox> {
    const base = this.deps.sandbox ?? { ...DEFAULT_SANDBOX, image: resolveVerifierImage() };
    const spec = req.tier === undefined ? base : strictSandboxFor(base, req.tier).spec;
    try {
      return await Sandbox.create(spec, this.deps.sandboxDeps);
    } catch (err) {
      if (err instanceof SandboxUnavailable) {
        throw new ForgeFailure("sandbox-unavailable", err.message, err);
      }
      // An image whose digest cannot be resolved is not "Docker is missing" — Docker is up,
      // and the refusal is that the run would be unidentifiable afterwards. It gets its own
      // kind rather than being filed under the outage copy, which would tell the operator to
      // start Docker when the thing to do is publish the image by digest.
      throw classify(err);
    }
  }

  /**
 * Read the files an agent is allowed to edit, for inclusion in the prompt.
 *
 * A unified diff carries verbatim context lines, so an agent that cannot see the file
 * cannot produce one that applies. This hands it the source — but never the pinned
 * suite, which is the one thing it must not copy from.
 *
 * Best-effort throughout: a file that cannot be read is simply absent, because a
 * transient read error must not abort a run that is otherwise fine.
 */
private async collectEditableFiles(
    sandbox: Sandbox,
  ): Promise<Record<string, string>> {
    const out: Record<string, string> = {};

    for (const rel of EDITABLE_GLOBS) {
      let text: string;
      try {
        text = await sandbox.readFile(rel);
      } catch {
        continue;
      }
      if (text) out[rel] = text;
    }

    return out;
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
    // The prompt tells the agent not to edit the pinned suite, and the built-in agent
    // checks its own output — but a runner cannot trust the agent it is driving. The
    // guard belongs here, before `git apply`, so an agent that rewrites its own exam
    // cannot pass even when the prompt is ignored.
    if (touchesTests(step.patch)) {
      throw new ForgeFailure("tests-modified", FAILURE_COPY["tests-modified"]);
    }
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
