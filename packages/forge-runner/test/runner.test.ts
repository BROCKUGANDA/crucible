import { describe, expect, it, vi } from "vitest";
import { defineAgent, summarise, type SmithAgent, type WorkContext } from "@crucible/smith";
import {
  FAILURE_COPY,
  ForgeFailure,
  ForgeRunner,
  classify,
  memorySink,
  readSuiteResults,
  suiteLine,
  type RunnerDeps,
  type RunRequest,
  type CommandResult,
} from "../src/index.js";

const CID_A = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const RUNNER = "0x1111111111111111111111111111111111111111" as const;
const TRIALS = "0x2222222222222222222222222222222222222222" as const;
/** The chain's bytes32 commitments for the trial's spec and suite. */
const SPEC_DIGEST = `0x${"33".repeat(32)}` as `0x${string}`;
const SUITE_DIGEST = `0x${"44".repeat(32)}` as `0x${string}`;

/**
 * Local, unisolated sandbox: these tests never need Docker. The runner still
 * probes for Docker once, which is why the suite has a generous timeout.
 */
const LOCAL_SANDBOX = {
  image: "crucible/verifier:test",
  memory: "1g",
  cpus: "1",
  timeoutSec: 60,
  allowLocalFallback: true,
  // Docker is installed on this machine but the pinned image does not exist, so a
  // container would fail for reasons unrelated to the code under test.
  forceLocal: true,
};

function forgeJson(passed: number, failed: number): string {
  const tests = [
    ...Array.from({ length: passed }, (_, i) => ({
      name: `test_Pass${i}`,
      status: "PASS",
      durationMs: 3,
    })),
    ...Array.from({ length: failed }, (_, i) => ({
      name: `test_Fail${i}`,
      status: "FAIL",
      durationMs: 4,
    })),
  ];
  return JSON.stringify({ tests });
}

interface HarnessOpts {
  /** run this instead of the default no-op step */
  step?: (
    ctx: WorkContext,
  ) => Promise<{
    patch: string;
    notes: string;
    done: boolean;
    withheld?: { suiteOutput: boolean };
  }>;
  agentThrows?: boolean;
  specThrows?: boolean;
  requireDocker?: boolean;
}

function harness(opts: HarnessOpts = {}): RunnerDeps {
  const agent: SmithAgent = opts.agentThrows
    ? defineAgent({
        name: "boom",
        capabilities: { domains: ["test"], model: "test-model", tools: [] },
        step: async () => {
          throw new Error("the agent exploded");
        },
      })
    : defineAgent({
        name: "tester",
        capabilities: { domains: ["test"], model: "test-model", tools: ["fs"] },
        step: async (ctx) => {
          if (opts.step) return opts.step(ctx);
          return { patch: "", notes: "ok", done: true };
        },
      });

  return {
    agent,
    sandbox: opts.requireDocker
      ? {
          image: LOCAL_SANDBOX.image,
          memory: LOCAL_SANDBOX.memory,
          cpus: LOCAL_SANDBOX.cpus,
          timeoutSec: LOCAL_SANDBOX.timeoutSec,
          allowLocalFallback: false,
          forceLocal: true, // still no probe: exercise the "Docker absent" branch
        }
      : LOCAL_SANDBOX,
    runnerAddress: RUNNER,
    chainId: 31337,
    verifyingContract: TRIALS,
    model: "test-model",
    status: memorySink().sink,
    fetchSpec: async () => {
      if (opts.specThrows) throw new Error("gateway down");
      return "# spec\n\ndo the thing\n";
    },
    fetchSuite: async () => "c".repeat(40),
    uploadLogs: async () => CID_A,
    uploadRepo: async () => CID_A,
    sign: async () => `0x${"11".repeat(65)}` as `0x${string}`,
    submit: async () => `0x${"22".repeat(32)}` as `0x${string}`,
  };
}

function request(over: Partial<RunRequest> = {}): RunRequest {
  return {
    trialId: 1,
    agentId: 1,
    specCID: CID_A,
    testsCID: CID_A,
    // `true` exits 0 with no output; readSuiteResults treats that as red, which is
    // the safe default for these tests. Green-path tests pass a real JSON emitter.
    suiteCommand: "false",
    timeBudgetSec: 300,
    iterBudget: 2,
    bondWei: 10n ** 15n,
    deadlineMs: Date.now() + 60_000,
    ...over,
  };
}

/** A suite command that prints forge-shaped JSON and exits 0. */
const GREEN_SUITE = `node -e "process.stdout.write(process.argv[1])" '${forgeJson(3, 0)}'`;

describe("readSuiteResults", () => {
  it("parses forge JSON from noisy output", () => {
    const out = `warning: something\n${forgeJson(3, 0)}\nCompiler run successful`;
    const results = readSuiteResults(out);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.status === "pass")).toBe(true);
  });

  it("synthesises a red result when the suite printed nothing parseable", () => {
    const results = readSuiteResults("Error: no tests found");
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("fail");
  });

  it("never throws on garbage", () => {
    expect(() => readSuiteResults("}{ not json at all")).not.toThrow();
  });
});

describe("summarise", () => {
  it("is green only with at least one pass and no failures", () => {
    expect(summarise([{ name: "a", status: "pass", durationMs: 0 }]).green).toBe(true);
    expect(summarise([]).green).toBe(false);
    expect(
      summarise([
        { name: "a", status: "pass", durationMs: 0 },
        { name: "b", status: "fail", durationMs: 0 },
      ]).green,
    ).toBe(false);
  });
});

describe("suiteLine", () => {
  it("uses the forge voice for both outcomes", () => {
    expect(suiteLine(3, 8, 12, 0)).toContain("12/12 green");
    expect(suiteLine(3, 8, 12, 5)).toBe("iter 3/8 — 5 red");
  });
});

describe("classify", () => {
  it("maps a named failure to its kind and copy", () => {
    const f = classify(new ForgeFailure("spec-unfetchable", "x"));
    expect(f.kind).toBe("spec-unfetchable");
    expect(FAILURE_COPY["spec-unfetchable"]).toContain("Couldn't pull the spec");
  });

  it("falls back to agent-threw with the original message", () => {
    const f = classify(new Error("kaboom"));
    expect(f.kind).toBe("agent-threw");
    expect(f.message).toBe("kaboom");
  });

  it("has copy for every failure kind", () => {
    for (const [k, v] of Object.entries(FAILURE_COPY)) {
      expect(v.length, `missing copy for ${k}`).toBeGreaterThan(0);
    }
  });
});

describe("ForgeRunner invariants", () => {
  it("refuses to start when the trial deadline has already passed", async () => {
    const runner = new ForgeRunner(harness());
    const out = await runner.run(request({ deadlineMs: Date.now() - 1000 }));
    expect(out.ok).toBe(false);
    expect(out.failure?.kind).toBe("deadline-exceeded");
    expect(out.iterations).toBe(0);
  });

  it("fails with spec-unfetchable rather than crashing", async () => {
    const runner = new ForgeRunner(harness({ specThrows: true }));
    const out = await runner.run(request());
    expect(out.ok).toBe(false);
    expect(out.failure?.kind).toBe("spec-unfetchable");
  });

  it("rejects a non-positive iteration budget", async () => {
    const runner = new ForgeRunner(harness());
    const out = await runner.run(request({ iterBudget: 0 }));
    expect(out.ok).toBe(false);
    expect(out.failure?.kind).toBe("suite-fails-budget");
  });

  it("submits exactly once when the suite goes green", async () => {
    const submit = vi.fn(async () => `0x${"22".repeat(32)}` as `0x${string}`);
    const deps = harness();
    deps.submit = submit;
    const runner = new ForgeRunner(deps);
    const out = await runner.run(
      request({ suiteCommand: GREEN_SUITE, iterBudget: 3 }),
    );
    expect(out.ok).toBe(true);
    expect(out.status).toBe("submitted");
    expect(submit).toHaveBeenCalledTimes(1);
    expect(out.artifact).toBeDefined();
    expect(out.artifact!.testResults.every((t) => t.status === "pass")).toBe(true);
    expect(out.summary?.green).toBe(true);
  }, 30_000);

  it("emits the manifest beside the artifact on the green path", async () => {
    const deps = harness();
    deps.manifest = {
      provider: "hetzner",
      modelVersion: "Qwen/Qwen3.6-35B-A3B",
      seed: "panel-2026-10-27",
      evaluator: { id: "argus", version: "1.4.0", rubricVersion: "3" },
      feeSchedule: "legacy-v1",
      feeScheduleVersion: "1",
    };
    const out = await new ForgeRunner(deps).run(
      request({
        suiteCommand: GREEN_SUITE,
        iterBudget: 3,
        specDigest: SPEC_DIGEST,
        suiteDigest: SUITE_DIGEST,
      }),
    );
    expect(out.ok).toBe(true);
    expect(out.manifest).toBeDefined();
    expect(out.manifest!.manifest.taskDigest).toBe(SPEC_DIGEST);
    expect(out.manifest!.manifest.suiteDigest).toBe(SUITE_DIGEST);
    expect(out.manifest!.manifest.model.version).toBe("Qwen/Qwen3.6-35B-A3B");
    expect(out.manifest!.manifest.scoring.feeSchedule).toBe("legacy-v1");
    expect(out.manifest!.digest).toMatch(/^0x[0-9a-f]{64}$/);
    // The manifest is not part of the signed artifact. Changing it must not
    // change the run hash, or it would have to be signed - and a signed
    // manifest would put an evaluation question on the money path.
    expect(out.runHash).toBeDefined();
  }, 30_000);

  it("emits no manifest rather than one with an invented task digest", async () => {
    const deps = harness();
    deps.manifest = {
      provider: "hetzner",
      modelVersion: "Qwen/Qwen3.6-35B-A3B",
      seed: "panel-2026-10-27",
      evaluator: { id: "argus", version: "1.4.0" },
      feeSchedule: "legacy-v1",
      feeScheduleVersion: "1",
    };
    // No specDigest on the request: the runner does not know the chain's
    // commitment, so it refuses to write one.
    const out = await new ForgeRunner(deps).run(
      request({ suiteCommand: GREEN_SUITE, iterBudget: 3 }),
    );
    expect(out.ok).toBe(true);
    expect(out.manifest).toBeUndefined();
  }, 30_000);

  it("tells the operator, without the withheld text, when the agent lost its suite output", async () => {
    const { sink, events } = memorySink();
    const deps = harness({
      step: async () => ({
        patch: "",
        notes: "Suite output from the previous iteration was withheld.",
        done: true,
        withheld: { suiteOutput: true },
      }),
    });
    deps.status = sink;
    const out = await new ForgeRunner(deps).run(
      request({ suiteCommand: GREEN_SUITE, iterBudget: 1 }),
    );
    expect(out.ok).toBe(true);

    const event = events.find((e) => e.withheld === "suite-output");
    expect(event, "no status event carried the withholding").toBeDefined();
    expect(event!.status).toBe("forging");
    expect(event!.label).toMatch(/withheld/i);
    // The status event is structural: it must not smuggle the withheld content along.
    expect(JSON.stringify(event)).not.toContain("from the previous iteration");

    // Negative control — an ordinary step must emit nothing with that flag, so a green here
    // means the emit is conditional rather than unconditional decoration.
    const plain = memorySink();
    const cleanDeps = harness();
    cleanDeps.status = plain.sink;
    await new ForgeRunner(cleanDeps).run(
      request({ suiteCommand: GREEN_SUITE, iterBudget: 1 }),
    );
    expect(plain.events.some((e) => e.withheld)).toBe(false);
  }, 30_000);

  it("never submits when the suite never goes green", async () => {
    const submit = vi.fn(async () => `0x${"22".repeat(32)}` as `0x${string}`);
    const deps = harness();
    deps.submit = submit;
    const runner = new ForgeRunner(deps);
    const out = await runner.run(request({ suiteCommand: "false", iterBudget: 2 }));
    expect(out.ok).toBe(false);
    expect(out.failure?.kind).toBe("suite-fails-budget");
    expect(submit).not.toHaveBeenCalled();
    expect(out.iterations).toBe(2);
  }, 30_000);

  it("never submits when the agent throws", async () => {
    const submit = vi.fn(async () => `0x${"22".repeat(32)}` as `0x${string}`);
    const deps = harness({ agentThrows: true });
    deps.submit = submit;
    const runner = new ForgeRunner(deps);
    const out = await runner.run(request());
    expect(out.ok).toBe(false);
    expect(out.failure?.kind).toBe("agent-threw");
    expect(submit).not.toHaveBeenCalled();
  }, 30_000);

  it("refuses a patch that touches the pinned test suite", async () => {
    const submit = vi.fn(async () => `0x${"22".repeat(32)}` as `0x${string}`);
    const deps = harness({
      step: async () => ({
        patch: [
          "diff --git a/test/Forge.t.sol b/test/Forge.t.sol",
          "--- a/test/Forge.t.sol",
          "+++ b/test/Forge.t.sol",
          "@@ -1,1 +1,1 @@",
          "-assertTrue(false);",
          "+assertTrue(true);",
          "",
        ].join("\n"),
        notes: "rewrote the exam",
        done: true,
      }),
    });
    deps.submit = submit;
    const runner = new ForgeRunner(deps);
    const out = await runner.run(request({ suiteCommand: GREEN_SUITE, iterBudget: 2 }));
    expect(out.ok).toBe(false);
    expect(out.failure?.kind).toBe("tests-modified");
    expect(submit).not.toHaveBeenCalled();
  }, 30_000);

  /**
   * The end state of a run that cannot be sealed, not the act of refusing.
   *
   * This used to read `expect(typeof out.degraded).toBe("boolean")`, which a run reporting
   * `degraded: false` while executing unisolated would have passed — a shape assertion on
   * the one field whose whole job is to be true. What is asserted now is that nothing was
   * produced that could claim isolation: no artifact, no run hash, no manifest, no submit.
   */
  it("produces nothing at all when Docker is required and absent", async () => {
    const submit = vi.fn(async () => `0x${"22".repeat(32)}` as `0x${string}`);
    const deps = harness({ requireDocker: true });
    deps.submit = submit;
    const out = await new ForgeRunner(deps).run(
      request({
        suiteCommand: GREEN_SUITE,
        iterBudget: 1,
        specDigest: SPEC_DIGEST,
        suiteDigest: SUITE_DIGEST,
      }),
    );
    expect(out.ok).toBe(false);
    expect(out.failure?.kind).toBe("sandbox-unavailable");
    expect(out.artifact).toBeUndefined();
    expect(out.runHash).toBeUndefined();
    expect(out.txHash).toBeUndefined();
    // No manifest either: an evaluation record for a run that did not execute would be a
    // second thing to falsify.
    expect(out.manifest).toBeUndefined();
    expect(submit).not.toHaveBeenCalled();
  }, 30_000);

  /**
   * `forceLocal` is the test-only escape hatch that executes without a container, and the
   * record it emits must say so. The failure this proves against is the one the field name
   * hides: a degraded run whose manifest environment still reads as a pinned, sealed
   * environment, because `degraded` was logged to a console and then dropped.
   */
  it("says unisolated in the record it emits when it ran without a container", async () => {
    const deps = harness();
    deps.manifest = {
      provider: "hetzner",
      modelVersion: "Qwen/Qwen3.6-35B-A3B",
      seed: "panel-2026-10-27",
      evaluator: { id: "argus", version: "1.4.0" },
      feeSchedule: "legacy-v1",
      feeScheduleVersion: "1",
    };
    const out = await new ForgeRunner(deps).run(
      request({
        suiteCommand: GREEN_SUITE,
        iterBudget: 1,
        specDigest: SPEC_DIGEST,
        suiteDigest: SUITE_DIGEST,
      }),
    );

    expect(out.ok).toBe(true);
    expect(out.degraded).toBe(true);
    const env = out.manifest!.manifest.environment;
    expect(env.isolation).toBe("unisolated");
    // The harness image is a tag, and a tag is not a digest: the field is absent rather
    // than filled with the reference the run was given.
    expect(env.imageDigest).toBeUndefined();
    expect("imageDigest" in env).toBe(false);
    expect(env.imageRequested).toBe("crucible/verifier:test");
  }, 30_000);

  /**
   * Both pins are evidence a third party fetches later: `rerunOnFreshBench` overlays
   * `repoCID`'s files onto a fresh bench (`packages/argus/src/live.ts:184`) and a skeptic reads
   * `logsCID` for the run's output. Pinned before the loop, the repo holds the sponsor's
   * unpacked suite with no answer in it and the logs hold the empty string — a re-run that
   * looks like a verification and verifies nothing.
   */
  describe("the artifact's content pins", () => {
    it("pins the repo and the logs after the work, not before it", async () => {
      let iterations = 0;
      let repoPinnedAtIteration = -1;
      let logged = "";

      const deps = harness({
        step: async () => {
          iterations += 1;
          return { patch: "", notes: "ok", done: true };
        },
      });
      deps.uploadRepo = async () => {
        repoPinnedAtIteration = iterations;
        return CID_A;
      };
      deps.uploadLogs = async (contents) => {
        logged = contents;
        return CID_A;
      };

      const out = await new ForgeRunner(deps).run(
        request({ suiteCommand: GREEN_SUITE, iterBudget: 1 }),
      );
      expect(out.ok).toBe(true);
      expect(repoPinnedAtIteration, "the repo was pinned before any iteration ran").toBe(1);
      expect(logged, "the logs were pinned from an empty run").toContain("test_Pass0");
      expect(logged).toContain("# iteration 1");
    }, 30_000);

    it("keeps every iteration's suite output in the logs, not just the last", async () => {
      let logged = "";
      const deps = harness({
        // `done` only on the second pass, so the loop runs twice and the log has to carry both.
        step: async (ctx) => ({
          patch: "",
          notes: ctx.iteration === 1 ? "still working" : "done",
          done: ctx.iteration > 1,
        }),
      });
      deps.uploadLogs = async (contents) => {
        logged = contents;
        return CID_A;
      };

      const out = await new ForgeRunner(deps).run(
        request({ suiteCommand: GREEN_SUITE, iterBudget: 3 }),
      );
      expect(out.ok).toBe(true);
      expect(out.iterations).toBe(2);
      expect(logged).toContain("# iteration 1");
      expect(logged).toContain("# iteration 2");
    }, 30_000);

    it("does not pin at all when the run never goes green", async () => {
      let repoPins = 0;
      let logPins = 0;
      const deps = harness();
      deps.uploadRepo = async () => {
        repoPins += 1;
        return CID_A;
      };
      deps.uploadLogs = async () => {
        logPins += 1;
        return CID_A;
      };

      const out = await new ForgeRunner(deps).run(request({ suiteCommand: "false", iterBudget: 2 }));
      expect(out.ok).toBe(false);
      expect(repoPins).toBe(0);
      expect(logPins).toBe(0);
    }, 30_000);
  });
});

/**
 * The container path, end to end, through the runner.
 *
 * Unit-level against an injected Docker CLI — this machine has the binary and no daemon, so
 * the real-container proof stays in `sandbox-docker.test.ts` and reports SKIPPED there. What
 * is proven here is the *wiring*, which no amount of container testing would prove: that the
 * digest resolved before the run is the reference `docker run` was handed, and the same value
 * that lands in the manifest. A resolver that works and a runner that ignores it is exactly
 * the shape of the original defect.
 */
describe("the container path records the image it launched", () => {
  const RESOLVED = `crucible/verifier@sha256:${"a".repeat(64)}`;
  const CONTAINER_SANDBOX = {
    image: "crucible/verifier:latest",
    memory: "1g",
    cpus: "1",
    timeoutSec: 60,
    allowLocalFallback: false,
  };

  const MANIFEST_INPUTS = {
    provider: "hetzner",
    modelVersion: "Qwen/Qwen3.6-35B-A3B",
    seed: "panel-2026-10-27",
    evaluator: { id: "argus", version: "1.4.0" },
    feeSchedule: "legacy-v1",
    feeScheduleVersion: "1",
  };

  function fakeDocker(inspectOk = true) {
    const runs: string[][] = [];
    const settle = (over: Partial<CommandResult>): CommandResult => ({
      stdout: "",
      stderr: "",
      code: 0,
      timedOut: false,
      durationMs: 1,
      ...over,
    });
    const exec = async (_bin: string, args: string[]): Promise<CommandResult> => {
      if (args[0] === "version") return settle({ stdout: "29.0.0" });
      if (args[0] === "image") {
        return inspectOk
          ? settle({ stdout: `["${RESOLVED}"]|sha256:${"c".repeat(64)}` })
          : settle({ code: 1, stderr: "No such image: crucible/verifier:latest" });
      }
      if (args[0] === "run") {
        runs.push(args);
        return settle({ stdout: forgeJson(3, 0) });
      }
      return settle({});
    };
    return { exec, runs };
  }

  function containerDeps(inspectOk = true) {
    const docker = fakeDocker(inspectOk);
    const deps = harness();
    deps.sandbox = CONTAINER_SANDBOX;
    deps.sandboxDeps = { exec: docker.exec };
    deps.manifest = MANIFEST_INPUTS;
    return { deps, docker };
  }

  const greenRequest = () =>
    request({
      suiteCommand: "forge test --json",
      iterBudget: 1,
      specDigest: SPEC_DIGEST,
      suiteDigest: SUITE_DIGEST,
    });

  it("launches the container from the resolved digest, not the tag", async () => {
    const { deps, docker } = containerDeps();
    const out = await new ForgeRunner(deps).run(greenRequest());

    expect(out.ok).toBe(true);
    expect(out.degraded).toBe(false);
    expect(docker.runs).toHaveLength(1);
    expect(docker.runs[0]).toContain(RESOLVED);
    expect(docker.runs[0]).not.toContain("crucible/verifier:latest");
  }, 30_000);

  it("records in the manifest the same reference it launched from", async () => {
    const { deps, docker } = containerDeps();
    const out = await new ForgeRunner(deps).run(greenRequest());

    const env = out.manifest!.manifest.environment;
    expect(env.imageDigest).toBe(RESOLVED);
    // The launch argv and the manifest are one value, not two claims about the same thing.
    expect(docker.runs[0]).toContain(env.imageDigest);
    expect(env.isolation).toBe("container");
    expect(env.imageRequested).toBe("crucible/verifier:latest");
  }, 30_000);

  it("refuses the run when the tag resolves to nothing, and submits nothing", async () => {
    const { deps, docker } = containerDeps(false);
    const submit = vi.fn(async () => `0x${"22".repeat(32)}` as `0x${string}`);
    deps.submit = submit;
    const out = await new ForgeRunner(deps).run(greenRequest());

    // End state: no container was ever started, and nothing was claimed about one.
    expect(out.ok).toBe(false);
    expect(out.failure?.kind).toBe("image-unresolved");
    expect(docker.runs).toHaveLength(0);
    expect(out.artifact).toBeUndefined();
    expect(out.manifest).toBeUndefined();
    expect(submit).not.toHaveBeenCalled();
  }, 30_000);

  it("raises the sandbox floor for a tier and records the raised spec, not the requested one", async () => {
    const { deps } = containerDeps();
    deps.sandbox = { ...CONTAINER_SANDBOX, timeoutSec: 60, memory: "256m" };
    const out = await new ForgeRunner(deps).run({
      ...greenRequest(),
      tier: 4,
    });

    expect(out.ok).toBe(true);
    const env = out.manifest!.manifest.environment;
    // Gate 901 raises the floor; a manifest quoting the caller's smaller numbers would
    // understate the environment the run actually had. Tier 4 is 8192m / 3600s.
    expect(env.limits?.memory).toBe("8192m");
    expect(env.limits?.wallClockSec).toBe("3600");
  }, 30_000);
});
