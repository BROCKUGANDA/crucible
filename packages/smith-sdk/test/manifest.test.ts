import { describe, expect, it } from "vitest";
import {
  assertCanonicalNumber,
  buildEvalManifest,
  compareManifests,
  EVAL_MANIFEST_SCHEMA_VERSION,
  manifestDigest,
  manifestsComparable,
  type EvalManifest,
} from "../src/manifest.js";

/**
 * The evaluation manifest is the thing that makes a score mean something.
 *
 * A score without one is a number: "this agent scored 0.90" says nothing
 * about which rubric, which suite, which temperature or which fee schedule
 * produced it. Two runs of the same model can differ because the model
 * changed, or because the rubric did, or because the harness did - and the
 * report has to be able to tell those apart, or it is not evidence.
 *
 * These tests are about the *digest* being a faithful fingerprint. The
 * mutation proofs at the end are the point: each one turns a claim red, and
 * a green that cannot be turned red is decoration.
 */

const HASH_A = "0x1111111111111111111111111111111111111111111111111111111111111111";
const HASH_B = "0x2222222222222222222222222222222222222222222222222222222222222222";
const HASH_C = "0x3333333333333333333333333333333333333333333333333333333333333333";

function baseManifest(overrides: Partial<Parameters<typeof buildEvalManifest>[0]> = {}) {
  return buildEvalManifest({
    taskDigest: HASH_A,
    datasetDigest: HASH_B,
    suiteDigest: HASH_C,
    evaluator: { id: "argus", version: "1.4.0", rubricVersion: "3" },
    model: { provider: "hetzner", name: "qwen", version: "Qwen/Qwen3.6-35B-A3B" },
    agent: {
      operator: "0xabc",
      scaffold: "forge-runner/2.1.0",
      systemPromptDigest: HASH_A,
      tools: ["bash", "read"],
      toolPermissions: { bash: HASH_B, read: HASH_C },
    },
    environment: {
      imageDigest: HASH_C,
      networkPolicy: "allowlist",
      timeoutMs: "600000",
      limits: { cpu: "2", memory: "2Gi" },
    },
    seed: "panel-2026-10-27",
    sampling: { temperature: "0.7", top_p: "0.95" },
    scoring: { feeSchedule: "legacy-v1", feeScheduleVersion: "1", decision: "deterministic-suite" },
    startedAt: "2026-10-27T12:00:00.000Z",
    finishedAt: "2026-10-27T12:00:41.000Z",
    ...overrides,
  });
}

describe("the manifest", () => {
  it("carries a schema version and every field needed to interpret a score", () => {
    const m = baseManifest();
    expect(m.schemaVersion).toBe(EVAL_MANIFEST_SCHEMA_VERSION);
    expect(m.taskDigest).toBe(HASH_A);
    expect(m.datasetDigest).toBe(HASH_B);
    expect(m.suiteDigest).toBe(HASH_C);
    expect(m.evaluator.id).toBe("argus");
    expect(m.evaluator.rubricVersion).toBe("3");
    expect(m.model.version).toBe("Qwen/Qwen3.6-35B-A3B");
    expect(m.agent?.scaffold).toBe("forge-runner/2.1.0");
    expect(m.environment.imageDigest).toBe(HASH_C);
    expect(m.seed).toBe("panel-2026-10-27");
    expect(m.scoring.feeSchedule).toBe("legacy-v1");
    expect(m.scoring.decision).toBe("deterministic-suite");
  });

  it("digests deterministically, and the digest changes when any pinned input changes", () => {
    const a = baseManifest();
    const b = baseManifest();
    expect(manifestDigest(a)).toBe(manifestDigest(b));

    // Each of these is a different evaluation, and the digest must say so.
    const variants: Array<[string, EvalManifest]> = [
      ["task", baseManifest({ taskDigest: HASH_B })],
      ["suite", baseManifest({ suiteDigest: HASH_B })],
      ["dataset", baseManifest({ datasetDigest: HASH_C })],
      ["evaluator", baseManifest({ evaluator: { id: "argus", version: "1.4.1" } })],
      ["rubric", baseManifest({ evaluator: { id: "argus", version: "1.4.0", rubricVersion: "4" } })],
      ["model", baseManifest({ model: { provider: "hetzner", name: "qwen", version: "Qwen/Qwen3.8-27B" } })],
      ["scaffold", baseManifest({ agent: { operator: "0xabc", scaffold: "forge-runner/2.2.0" } })],
      ["image", baseManifest({ environment: { imageDigest: HASH_A } })],
      ["seed", baseManifest({ seed: "panel-2026-10-28" })],
      [
        "temperature",
        baseManifest({ sampling: { temperature: "0.8", top_p: "0.95" } }),
      ],
      [
        "fee schedule",
        baseManifest({
          scoring: { feeSchedule: "arena-v2", feeScheduleVersion: "1", decision: "deterministic-suite" },
        }),
      ],
    ];
    const base = manifestDigest(a);
    for (const [name, variant] of variants) {
      expect(manifestDigest(variant), `${name} must change the digest`).not.toBe(base);
    }
  });

  it("does not let key order change the digest", () => {
    const m = baseManifest();
    const reordered = {
      finishedAt: m.finishedAt,
      startedAt: m.startedAt,
      ...m,
    } as EvalManifest;
    expect(manifestDigest(reordered)).toBe(manifestDigest(m));
  });

  it("refuses a moving model alias, because an alias is not a version", () => {
    expect(() =>
      baseManifest({ model: { provider: "openai", name: "gpt", version: "gpt-latest" } }),
    ).toThrow(/moving alias/);
    expect(() =>
      baseManifest({ model: { provider: "openai", name: "gpt", version: "gpt-4.1-preview" } }),
    ).toThrow(/moving alias/);
  });

  it("refuses an unpinned evaluator and an empty seed", () => {
    expect(() => baseManifest({ evaluator: { id: "argus", version: "  " } })).toThrow(/evaluator/);
    expect(() => baseManifest({ seed: "   " })).toThrow(/seed/);
  });

  /**
   * A field named `imageDigest` is read as a pin by everyone who sees it, including the
   * skeptic paid to re-run the work. A mutable tag inside it is therefore worse than an
   * absent one: absence is legible, a tag is a claim that cannot be honoured. The forge
   * runner produced exactly this for as long as the field existed, which is why the check
   * sits in the shared builder rather than only in the producer — any producer, including
   * one written tomorrow, has to pass through here.
   */
  it("refuses a mutable tag where it asks for an image digest", () => {
    expect(() =>
      baseManifest({ environment: { imageDigest: "crucible/verifier:latest" } }),
    ).toThrow(/not an immutable digest/);
    expect(() =>
      baseManifest({ environment: { imageDigest: "python:3.12-alpine" } }),
    ).toThrow(/not an immutable digest/);
    // A truncated digest is not a digest either.
    expect(() => baseManifest({ environment: { imageDigest: "sha256:abc" } })).toThrow(
      /not an immutable digest/,
    );
  });

  it("accepts every immutable digest shape a real producer has", () => {
    const pinned = `crucible/verifier@sha256:${"a".repeat(64)}`;
    const localId = `sha256:${"b".repeat(64)}`;
    const bareHex = "c".repeat(64); // the grader's corpus epoch: a content digest, no prefix
    for (const value of [HASH_A, pinned, localId, bareHex]) {
      expect(baseManifest({ environment: { imageDigest: value } }).environment.imageDigest).toBe(
        value,
      );
    }
    // And absence is honest, not an error: a run with no container has no image digest.
    expect(
      "imageDigest" in
        baseManifest({ environment: { imageRequested: "crucible/verifier:latest" } }).environment,
    ).toBe(false);
  });

  it("refuses timestamps that are not dates", () => {
    expect(() => baseManifest({ startedAt: "yesterday" })).toThrow(/ISO-8601/);
  });

  it("refuses an unsorted tool list, because two equal sets must hash alike", () => {
    expect(() =>
      baseManifest({
        agent: { operator: "0xabc", scaffold: "forge-runner/2.1.0", tools: ["read", "bash"] },
      }),
    ).toThrow(/sorted/);
  });

  it("refuses a sampling value that is not its shortest round-trip form", () => {
    // "1.50" and "1.5" are the same number and JCS renders them alike, so a
    // manifest that accepted "1.50" would produce a digest that looks like
    // "1.5" and cannot be told apart from it.
    expect(() => baseManifest({ sampling: { temperature: "1.50" } })).toThrow(/shortest round-trip/);
    expect(() => baseManifest({ sampling: { temperature: " 0.7" } })).toThrow(/whitespace/);
    expect(() => baseManifest({ sampling: { temperature: "0,7" } })).toThrow(/plain decimal/);
    expect(() => assertCanonicalNumber("0.7", "sampling.temperature")).not.toThrow();
  });
});

describe("comparing two evaluations", () => {
  it("names the field that moved, so 'the model improved' is a checkable claim", () => {
    const before = baseManifest();
    const after = baseManifest({
      model: { provider: "hetzner", name: "qwen", version: "Qwen/Qwen3.8-27B" },
    });
    const differences = compareManifests(before, after);
    const paths = differences.map((d) => d.path);
    expect(paths).toContain("model.version");
    // Only the model moved.
    expect(paths).toEqual(["model.version"]);
  });

  it("treats a rubric change as a difference, because it changes what a score means", () => {
    const before = baseManifest();
    const after = baseManifest({
      evaluator: { id: "argus", version: "1.4.0", rubricVersion: "4" },
    });
    expect(compareManifests(before, after).map((d) => d.path)).toEqual(["evaluator.rubricVersion"]);
    expect(manifestsComparable(before, after)).toBe(false);
  });

  it("treats a different fee schedule as incomparable, not as a model change", () => {
    const legacy = baseManifest();
    const arena = baseManifest({
      scoring: { feeSchedule: "arena-v2", feeScheduleVersion: "1", decision: "deterministic-suite" },
    });
    // Both schedules are at their own version 1, so only the schedule name moved.
    // That is the point: two schedules are two different games, and the digest
    // has to say which one priced the run.
    const differences = compareManifests(legacy, arena);
    expect(differences.map((d) => d.path)).toEqual(["scoring.feeSchedule"]);
    expect(manifestsComparable(legacy, arena)).toBe(false);

    // And a version bump inside a schedule is its own difference.
    const arenaV2 = baseManifest({
      scoring: { feeSchedule: "arena-v2", feeScheduleVersion: "2", decision: "deterministic-suite" },
    });
    expect(compareManifests(arena, arenaV2).map((d) => d.path)).toEqual(["scoring.feeScheduleVersion"]);
  });

  it("still compares two runs of the same manifest, which is a repeat measurement", () => {
    const first = baseManifest();
    const second = baseManifest({
      startedAt: "2026-10-27T13:00:00.000Z",
      finishedAt: "2026-10-27T13:00:38.000Z",
    });
    expect(compareManifests(first, second).map((d) => d.path).sort()).toEqual([
      "finishedAt",
      "startedAt",
    ]);
    expect(manifestsComparable(first, second)).toBe(true);
  });

  it("reports a field present in one manifest and absent in the other", () => {
    const withTools = baseManifest();
    const withoutTools = baseManifest({
      agent: { operator: "0xabc", scaffold: "forge-runner/2.1.0" },
    });
    const paths = compareManifests(withTools, withoutTools).map((d) => d.path);
    // "the tool set was pinned" and "the tool set was not" are different
    // evaluations, and a comparison that treated them as equal would compare
    // an unrestricted run against a restricted one. The permission map is
    // reported per tool, because knowing *which* tool's permission moved is
    // the diagnostic a reader needs.
    expect(paths).toContain("agent.tools");
    expect(paths).toContain("agent.toolPermissions.bash");
    expect(paths).toContain("agent.toolPermissions.read");
    expect(manifestsComparable(withTools, withoutTools)).toBe(false);
  });

  it("does not confuse an absent optional field with a present empty one", () => {
    const withoutDataset = baseManifest({ datasetDigest: undefined });
    const withEmptyDataset = baseManifest({ datasetDigest: HASH_A });
    expect(compareManifests(withoutDataset, withEmptyDataset).map((d) => d.path)).toEqual([
      "datasetDigest",
    ]);
  });

  it("does not confuse a field present-but-undefined with one omitted entirely", () => {
    // A manifest that names a field with `undefined` and one that omits the
    // key are different documents, even though `JSON.stringify` renders both
    // to the same text. The comparator checks presence as well as value,
    // because "this was pinned to nothing" and "this was not pinned at all"
    // are not the same evaluation.
    const present = { ...baseManifest(), datasetDigest: undefined };
    const omitted: EvalManifest = { ...baseManifest() };
    delete (omitted as Partial<EvalManifest>).datasetDigest;

    const paths = compareManifests(present, omitted).map((d) => d.path);
    expect(paths).toEqual(["datasetDigest"]);
    expect(manifestsComparable(present, omitted)).toBe(false);
  });
});

/**
 * The mutation proofs.
 *
 * A green that cannot be turned red is decoration. Each mutation below
 * breaks exactly one claim, and the suite must notice.
 */
describe("the claims are falsifiable", () => {
  it("a digest that ignores the rubric is caught", () => {
    const before = baseManifest();
    const after = baseManifest({
      evaluator: { id: "argus", version: "1.4.0", rubricVersion: "4" },
    });
    expect(manifestDigest(before)).not.toBe(manifestDigest(after));
  });

  it("a comparison that ignored the fee schedule is caught", () => {
    const legacy = baseManifest();
    const arena = baseManifest({
      scoring: { feeSchedule: "arena-v2", feeScheduleVersion: "1", decision: "deterministic-suite" },
    });
    expect(manifestsComparable(legacy, arena)).toBe(false);
  });

  it("a builder that accepted a moving alias is caught", () => {
    expect(() =>
      baseManifest({ model: { provider: "openai", name: "gpt", version: "gpt-live" } }),
    ).toThrow();
  });

  it("a builder that accepted an empty seed is caught", () => {
    expect(() => baseManifest({ seed: "" })).toThrow();
  });

  it("a builder that accepted unsorted tools is caught", () => {
    expect(() =>
      baseManifest({ agent: { operator: "0xabc", scaffold: "s", tools: ["z", "a"] } }),
    ).toThrow();
  });

  it("a builder that accepted a non-canonical number is caught", () => {
    expect(() => baseManifest({ sampling: { temperature: "0.70" } })).toThrow();
  });

  it("a comparator that ignored a missing field is caught", () => {
    const withTools = baseManifest();
    const without = baseManifest({ agent: { operator: "0xabc", scaffold: "forge-runner/2.1.0" } });
    expect(manifestsComparable(withTools, without)).toBe(false);
  });

  it("a comparator that ignored presence is caught", () => {
    // Present-but-undefined against omitted: equal by value, different by
    // presence. The branch that checks presence is load-bearing.
    const present = { ...baseManifest(), datasetDigest: undefined };
    const omitted: EvalManifest = { ...baseManifest() };
    delete (omitted as Partial<EvalManifest>).datasetDigest;
    expect(compareManifests(present, omitted).map((d) => d.path)).toEqual(["datasetDigest"]);
  });
});
