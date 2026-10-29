import { describe, expect, it } from "vitest";
import { buildEvalManifest, manifestDigest, manifestsComparable } from "@crucible/smith";
import {
  buildRunManifest,
  emitManifest,
  environmentOf,
  type ManifestInputs,
} from "../src/index.js";

/**
 * The runner emits the manifest, and what it emits has to be *true*.
 *
 * The failure this guards against is specific: a manifest that fills in a
 * field it does not know. A `taskDigest` of zeros, a rubric version of "1",
 * an environment of "unknown" - each is indistinguishable, to every consumer
 * downstream, from a manifest that knew the value. A score attributed to
 * conditions nobody pinned is worse than a score attributed to none.
 *
 * So the rules are: **absent means absent**, and the split of knowledge is
 * the design. The operator knows the trial's on-chain commitments and the
 * evaluation's policy; the runner knows the environment it ran in and when.
 */

const SPEC = "0x1111111111111111111111111111111111111111111111111111111111111111" as const;
const SUITE = "0x2222222222222222222222222222222222222222222222222222222222222222" as const;

function inputs(over: Partial<ManifestInputs> = {}): ManifestInputs {
  return {
    specDigest: SPEC,
    suiteDigest: SUITE,
    provider: "hetzner",
    model: "qwen",
    modelVersion: "Qwen/Qwen3.6-35B-A3B",
    seed: "panel-2026-10-27",
    sampling: { temperature: "0.7" },
    evaluator: { id: "argus", version: "1.4.0", rubricVersion: "3" },
    feeSchedule: "legacy-v1",
    feeScheduleVersion: "1",
    ...over,
  };
}

const LOCAL_SANDBOX = {
  image: "crucible/verifier:test",
  memory: "1g",
  cpus: "2",
  timeoutSec: 900,
};

/** What the sandbox resolves `crucible/verifier:test` to before it launches the container. */
const RESOLVED = `crucible/verifier@sha256:${"a".repeat(64)}`;

describe("the environment the run records", () => {
  it("records the resolved digest as the digest and the tag only as the request", () => {
    const env = environmentOf({
      sandbox: LOCAL_SANDBOX,
      imageDigest: RESOLVED,
      degraded: false,
    });
    // The field named for a digest carries a digest. The tag is still recorded — it is a
    // true fact about what the operator asked for — but where its own name says "requested".
    expect(env.imageDigest).toBe(RESOLVED);
    expect(env.imageRequested).toBe(LOCAL_SANDBOX.image);
    expect(env.limits?.memory).toBe("1g");
    expect(env.limits?.cpus).toBe("2");
    expect(env.limits?.wallClockSec).toBe("900");
  });

  it("never writes the requested tag into imageDigest", () => {
    const env = environmentOf({ sandbox: LOCAL_SANDBOX, degraded: false });
    // Unresolved is recorded as *absent*, not as the tag: a reader must be able to tell
    // "this environment is pinned" from "nobody could pin it", and a tag in a field named
    // imageDigest reads as the former either way.
    expect(env.imageDigest).toBeUndefined();
    expect("imageDigest" in env).toBe(false);
    expect(env.imageRequested).toBe(LOCAL_SANDBOX.image);
    // And the shared builder refuses the tag outright, so no producer can launder one in.
    expect(() =>
      buildEvalManifest(
        {
          taskDigest: SPEC,
          suiteDigest: SUITE,
          evaluator: { id: "argus", version: "1.4.0" },
          model: { provider: "hetzner", name: "qwen", version: "Qwen/Qwen3.6-35B-A3B" },
          environment: { imageDigest: LOCAL_SANDBOX.image },
          seed: "s",
          scoring: {
            feeSchedule: "legacy-v1",
            feeScheduleVersion: "1",
            decision: "deterministic-suite",
          },
          startedAt: "2026-10-27T12:00:00.000Z",
          finishedAt: "2026-10-27T12:00:41.000Z",
        },
      ),
    ).toThrow(/not an immutable digest/);
  });

  it("drops a digest for a run that had no container to run it in", () => {
    const env = environmentOf({
      sandbox: LOCAL_SANDBOX,
      imageDigest: RESOLVED,
      degraded: true,
    });
    // Nothing was containerised, so no image ran; whatever the caller had resolved describes
    // an environment this run did not use, and recording it would be a fresh lie.
    expect(env.imageDigest).toBeUndefined();
    expect(env.isolation).toBe("unisolated");
  });

  it("says in the record which way the run was isolated", () => {
    expect(
      environmentOf({ sandbox: LOCAL_SANDBOX, imageDigest: RESOLVED, degraded: false }).isolation,
    ).toBe("container");
    expect(environmentOf({ sandbox: LOCAL_SANDBOX, degraded: true }).isolation).toBe("unisolated");
  });

  it("records the budget as a number, because a string would be read as a different unit", () => {
    const env = environmentOf({
      sandbox: LOCAL_SANDBOX,
      imageDigest: RESOLVED,
      degraded: false,
      timeoutMs: 900_000,
    });
    expect(env.timeoutMs).toBe(900_000);
    expect(typeof env.timeoutMs).toBe("number");
  });

  it("says 'unspecified' rather than inventing a network policy", () => {
    const env = environmentOf({ sandbox: LOCAL_SANDBOX, degraded: false });
    // No egress block on the spec means the policy is not described - and
    // "unspecified" is honest in a way an empty allowlist is not.
    expect(env.networkPolicy).toBe("unspecified");
  });

  it("summarises a declared egress policy without listing it", () => {
    const env = environmentOf({
      sandbox: {
        ...LOCAL_SANDBOX,
        egress: { allow: ["api.example"], deny: ["169.254.169.254"] },
      } as never,
      degraded: false,
    });
    expect(env.networkPolicy).toBe("allow:1/deny:1");
  });
});

describe("the manifest the runner emits", () => {
  it("pins the trial's commitments, the model and the seed", () => {
    const { manifest } = emitManifest(inputs(), { sandbox: LOCAL_SANDBOX, degraded: false }, "2026-10-27T12:00:00.000Z", "2026-10-27T12:00:41.000Z");
    expect(manifest.taskDigest).toBe(SPEC);
    expect(manifest.suiteDigest).toBe(SUITE);
    expect(manifest.model.provider).toBe("hetzner");
    expect(manifest.model.version).toBe("Qwen/Qwen3.6-35B-A3B");
    expect(manifest.seed).toBe("panel-2026-10-27");
    expect(manifest.evaluator.rubricVersion).toBe("3");
    expect(manifest.scoring.feeSchedule).toBe("legacy-v1");
    expect(manifest.scoring.decision).toBe("deterministic-suite");
  });

  it("emits a digest a consumer can fetch by", () => {
    const emitted = emitManifest(inputs(), { sandbox: LOCAL_SANDBOX, degraded: false }, "2026-10-27T12:00:00.000Z", "2026-10-27T12:00:41.000Z");
    expect(emitted.digest).toBe(manifestDigest(emitted.manifest));
    expect(emitted.digest).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("is reproducible: the same inputs give the same digest", () => {
    const a = emitManifest(inputs(), { sandbox: LOCAL_SANDBOX, degraded: false }, "2026-10-27T12:00:00.000Z", "2026-10-27T12:00:41.000Z");
    const b = emitManifest(inputs(), { sandbox: LOCAL_SANDBOX, degraded: false }, "2026-10-27T12:00:00.000Z", "2026-10-27T12:00:41.000Z");
    expect(a.digest).toBe(b.digest);
  });

  it("changes its digest when the environment changes", () => {
    const before = emitManifest(inputs(), { sandbox: LOCAL_SANDBOX, degraded: false }, "2026-10-27T12:00:00.000Z", "2026-10-27T12:00:41.000Z");
    const after = emitManifest(
      inputs(),
      { sandbox: { ...LOCAL_SANDBOX, image: "crucible/verifier:other" }, degraded: false },
      "2026-10-27T12:00:00.000Z",
      "2026-10-27T12:00:41.000Z",
    );
    expect(after.digest).not.toBe(before.digest);
  });

  it("omits what it does not know rather than inventing it", () => {
    const { manifest } = emitManifest(
      inputs({ datasetDigest: undefined, scaffold: undefined, systemPromptDigest: undefined, tools: undefined }),
      { sandbox: LOCAL_SANDBOX, degraded: false },
      "2026-10-27T12:00:00.000Z",
      "2026-10-27T12:00:41.000Z",
    );
    // A dataset that was never used, and a scaffold nobody named, are absent -
    // not "unknown" and not a zero digest.
    expect("datasetDigest" in manifest).toBe(false);
    expect(manifest.agent).toBeUndefined();
  });

  it("records the agent facts when the operator supplies them", () => {
    const { manifest } = emitManifest(
      inputs({
        scaffold: "forge-runner/2.1.0",
        systemPromptDigest: SPEC,
        tools: ["bash", "read"],
      }),
      { sandbox: LOCAL_SANDBOX, degraded: false },
      "2026-10-27T12:00:00.000Z",
      "2026-10-27T12:00:41.000Z",
    );
    expect(manifest.agent?.scaffold).toBe("forge-runner/2.1.0");
    expect(manifest.agent?.tools).toEqual(["bash", "read"]);
  });

  it("sorts the tool list, so two equal sets hash alike", () => {
    const sorted = buildRunManifest(
      inputs({ scaffold: "s", tools: ["bash", "read"] }),
      { sandbox: LOCAL_SANDBOX, degraded: false },
      "2026-10-27T12:00:00.000Z",
      "2026-10-27T12:00:41.000Z",
    );
    const unsorted = buildRunManifest(
      inputs({ scaffold: "s", tools: ["read", "bash"] }),
      { sandbox: LOCAL_SANDBOX, degraded: false },
      "2026-10-27T12:00:00.000Z",
      "2026-10-27T12:00:41.000Z",
    );
    // The builder refuses an unsorted list outright, so the manifest that
    // reaches the digest is always sorted.
    expect(sorted.agent?.tools).toEqual(["bash", "read"]);
    expect(manifestDigest(sorted)).toBe(manifestDigest(unsorted));
  });

  it("refuses a moving model alias, so a published evaluation stays comparable", () => {
    expect(() =>
      buildRunManifest(
        inputs({ modelVersion: "gpt-latest" }),
        { sandbox: LOCAL_SANDBOX, degraded: false },
        "2026-10-27T12:00:00.000Z",
        "2026-10-27T12:00:41.000Z",
      ),
    ).toThrow(/moving alias/);
  });

  it("refuses a non-canonical sampling value", () => {
    expect(() =>
      buildRunManifest(
        inputs({ sampling: { temperature: "0.70" } }),
        { sandbox: LOCAL_SANDBOX, degraded: false },
        "2026-10-27T12:00:00.000Z",
        "2026-10-27T12:00:41.000Z",
      ),
    ).toThrow(/shortest round-trip/);
  });

  it("refuses an empty seed", () => {
    expect(() =>
      buildRunManifest(
        inputs({ seed: "  " }),
        { sandbox: LOCAL_SANDBOX, degraded: false },
        "2026-10-27T12:00:00.000Z",
        "2026-10-27T12:00:41.000Z",
      ),
    ).toThrow(/seed/);
  });

  it("makes two runs under different fee schedules incomparable", () => {
    const legacy = buildRunManifest(inputs(), { sandbox: LOCAL_SANDBOX, degraded: false }, "2026-10-27T12:00:00.000Z", "2026-10-27T12:00:41.000Z");
    const arena = buildRunManifest(
      inputs({ feeSchedule: "arena-v2" }),
      { sandbox: LOCAL_SANDBOX, degraded: false },
      "2026-10-27T12:00:00.000Z",
      "2026-10-27T12:00:41.000Z",
    );
    expect(manifestsComparable(legacy, arena)).toBe(false);
  });

  it("makes two runs of the same evaluation comparable", () => {
    const first = buildRunManifest(inputs(), { sandbox: LOCAL_SANDBOX, degraded: false }, "2026-10-27T12:00:00.000Z", "2026-10-27T12:00:41.000Z");
    const second = buildRunManifest(inputs(), { sandbox: LOCAL_SANDBOX, degraded: false }, "2026-10-27T13:00:00.000Z", "2026-10-27T13:00:38.000Z");
    expect(manifestsComparable(first, second)).toBe(true);
  });
});
