import { describe, expect, it } from "vitest";
import {
  checkPatchPolicy,
  describePatchViolations,
  isHarnessPath,
  isTestPath,
  matchGlob,
  normalisePatchPath,
  validatePatchPolicy,
} from "../src/patch-policy.js";

describe("normalisePatchPath", () => {
  it("keeps a plain relative path", () => {
    expect(normalisePatchPath("src/lib/thing.ts")).toBe("src/lib/thing.ts");
  });

  it("refuses every way out of the workspace", () => {
    // Each of these has been a real path traversal somewhere. The check is a
    // refusal, not a repair: a path that cannot be normalised is one this
    // module cannot reason about.
    for (const bad of [
      "../etc/passwd",
      "src/../../x",
      "/etc/passwd",
      "C:/Windows/system32",
      "c:\\windows",
      "src\\lib\\x.ts",
      "//server/share/x",
      "src/./x",
      "",
      "   ",
      "~/.ssh/id_rsa",
    ]) {
      expect(normalisePatchPath(bad), bad).toBeNull();
    }
  });

  it("treats /dev/null as a marker, not a path", () => {
    expect(normalisePatchPath("/dev/null")).toBeNull();
  });
});

describe("matchGlob", () => {
  it("spans segments only with a whole ** segment", () => {
    expect(matchGlob("src/**/x.ts", "src/x.ts")).toBe(true);
    expect(matchGlob("src/**/x.ts", "src/a/b/x.ts")).toBe(true);
    expect(matchGlob("src/*/x.ts", "src/a/b/x.ts")).toBe(false);
    expect(matchGlob("**/evaluator/**", "pkg/evaluator/run.ts")).toBe(true);
    expect(matchGlob("**/.git/**", ".git/config")).toBe(true);
  });

  it("does not let a wildcard cross into a sibling prefix", () => {
    expect(matchGlob("src/*.ts", "src/a.ts")).toBe(true);
    expect(matchGlob("src/*.ts", "src/a/b.ts")).toBe(false);
    // A naive `startsWith` would say yes here.
    expect(matchGlob("src/valid.*", "src/valid/../secret")).toBe(false);
  });
});

describe("checkPatchPolicy", () => {
  it("passes a patch inside the allowlist", () => {
    const result = checkPatchPolicy(
      [{ path: "src/worker.ts" }, { path: "src/queue.ts" }],
      { allowedPaths: ["src/**"] },
    );
    expect(result.ok).toBe(true);
    expect(result.files).toEqual(["src/worker.ts", "src/queue.ts"]);
  });

  it("refuses a file outside a declared allowlist", () => {
    const result = checkPatchPolicy([{ path: "package.json" }], { allowedPaths: ["src/**"] });
    expect(result.ok).toBe(false);
    expect(result.violations[0]?.code).toBe("outside_allowed");
  });

  it("refuses a test edit unless the task allows one", () => {
    const closed = checkPatchPolicy([{ path: "test/worker.test.ts" }]);
    expect(closed.violations.map((v) => v.code)).toContain("test_edit");

    // Feature-acceptance tasks own their suite; the flag is the only way in.
    const open = checkPatchPolicy([{ path: "test/worker.test.ts" }], { allowTestEdits: true });
    expect(open.ok).toBe(true);
  });

  it("never lets a task allow the evaluator, hidden tests, harness or .git", () => {
    // allowTestEdits is not a master key: these are refused even with every
    // permissive flag set, which is the property the guard exists for.
    for (const path of [
      "packages/evaluator/run.ts",
      "hidden-tests/case-1.json",
      "harness/driver.ts",
      ".git/config",
    ]) {
      const result = checkPatchPolicy([{ path }], {
        allowedPaths: ["**"],
        allowTestEdits: true,
      });
      expect(result.ok, path).toBe(false);
      expect(result.violations.map((v) => v.code), path).toContain("harness_edit");
    }
  });

  it("checks the pre-rename path too, so a rename cannot smuggle a file out", () => {
    const result = checkPatchPolicy(
      [{ path: "src/moved.ts", previousPath: "hidden-tests/answer.json", change: "renamed" }],
      { allowedPaths: ["src/**"] },
    );
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.path === "hidden-tests/answer.json")).toBe(true);
  });

  it("flags a binary change", () => {
    const result = checkPatchPolicy([{ path: "src/logo.png", binary: true }], { allowedPaths: ["src/**"] });
    expect(result.ok).toBe(false);
    expect(result.violations[0]?.code).toBe("binary_change");
  });

  it("reports a bad path as a violation, not a skip", () => {
    const result = checkPatchPolicy([{ path: "../../etc/passwd" }]);
    expect(result.ok).toBe(false);
    expect(result.violations[0]?.code).toBe("bad_path");
  });
});

describe("validatePatchPolicy", () => {
  it("refuses an allowlist that would allow nothing", () => {
    expect(validatePatchPolicy({ allowedPaths: [] }).join(" ")).toMatch(/empty/);
  });

  it("refuses a pattern that escapes or uses ** inside a segment", () => {
    expect(validatePatchPolicy({ allowedPaths: ["../src/**"] }).join(" ")).toMatch(/escapes/);
    expect(validatePatchPolicy({ allowedPaths: ["/src/**"] }).join(" ")).toMatch(/relative/);
    expect(validatePatchPolicy({ allowedPaths: ["src/**.ts"] }).join(" ")).toMatch(/whole segment/);
    expect(validatePatchPolicy({ allowedPaths: ["src\\**"] }).join(" ")).toMatch(/relative/);
  });

  it("accepts a normal policy", () => {
    expect(
      validatePatchPolicy({ allowedPaths: ["src/**", "docs/*.md"], forbiddenPaths: ["src/secrets/**"] }),
    ).toEqual([]);
  });
});

describe("path classifiers", () => {
  it("recognises the test conventions this repository uses", () => {
    expect(isTestPath("packages/a/test/x.ts")).toBe(true);
    expect(isTestPath("packages/a/src/x.test.ts")).toBe(true);
    expect(isTestPath("test/Invariants.t.sol")).toBe(true);
    expect(isTestPath("src/contest.ts")).toBe(false);
  });

  it("recognises the harness and the evaluator", () => {
    expect(isHarnessPath("packages/evaluator/score.ts")).toBe(true);
    expect(isHarnessPath("x/.git/HEAD")).toBe(true);
    expect(isHarnessPath("src/harnessed.ts")).toBe(false);
  });
});

describe("describePatchViolations", () => {
  it("names the first cause and counts the rest", () => {
    const message = describePatchViolations([
      { path: "a.ts", code: "outside_allowed", detail: "outside" },
      { path: "b.ts", code: "binary_change", detail: "binary" },
    ]);
    expect(message).toContain("outside_allowed at a.ts");
    expect(message).toContain("+1 more");
    expect(describePatchViolations([])).toMatch(/declared scope/);
  });
});
