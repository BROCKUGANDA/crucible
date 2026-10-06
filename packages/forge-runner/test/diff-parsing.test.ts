import { describe, expect, it } from "vitest";
import { extractDiff, filesTouched, touchesTests } from "../src/agent";

/**
 * The headerless-diff regression.
 *
 * This file exists because a real model was run against the prompt, and it did not do
 * what the original parser assumed. Asked for a git-format diff, Groq's
 * qwen3.8-27b produced:
 *
 *     ```diff
 *     --- a/src/Forge.sol
 *     +++ b/src/Forge.sol
 *     @@ -4,5 +4,7 @@ contract Forge {
 *     ...
 *     ```
 *
 * No `diff --git` line. The old parser searched for one, returned "", and — because
 * `filesTouched` only ever read that same header — reported zero files. `touchesTests`
 * then answered `false`. In other words a model that rewrote the pinned test suite
 * would have been waved through by the guard that exists to stop exactly that.
 *
 * Every case below is a shape a real model actually emits.
 */

const GIT_FORM = `diff --git a/src/Forge.sol b/src/Forge.sol
index 1111111..2222222 100644
--- a/src/Forge.sol
+++ b/src/Forge.sol
@@ -4,5 +4,7 @@ contract Forge {
   uint256 public total;
-  function increment() external {}
+  function increment() external {
+    total += 1;
+  }
 }`;

const HEADERLESS_FORM = `--- a/src/Forge.sol
+++ b/src/Forge.sol
@@ -4,5 +4,7 @@ contract Forge {
   uint256 public total;
-  function increment() external {}
+  function increment() external {
+    total += 1;
+  }
 }`;

describe("extractDiff: the git header form", () => {
  it("extracts a diff with a diff --git header", () => {
    const out = extractDiff(GIT_FORM);
    expect(out).toContain("diff --git a/src/Forge.sol b/src/Forge.sol");
    expect(out).toContain("+    total += 1;");
  });

  it("keeps the index line, which git apply uses", () => {
    expect(extractDiff(GIT_FORM)).toContain("index 1111111..2222222");
  });
});

describe("extractDiff: the headerless form", () => {
  it("extracts a bare unified diff", () => {
    const out = extractDiff(HEADERLESS_FORM);
    expect(out).toContain("--- a/src/Forge.sol");
    expect(out).toContain("+++ b/src/Forge.sol");
    expect(out).toContain("@@ -4,5 +4,7 @@");
  });

  it("unwraps a fence around a bare unified diff", () => {
    // This is verbatim what the live model returned.
    const raw = "```diff\n" + HEADERLESS_FORM + "\n```";
    expect(extractDiff(raw)).toContain("total += 1;");
  });

  it("does not mistake a bare --- separator for a file header", () => {
    // `---` alone, with no `+++` partner, is not a diff. A removed line whose content
    // is `--` also renders as `---`, which is why pairing matters.
    expect(extractDiff("---\nnot a diff\n")).toBe("");
    expect(extractDiff("Some text\n---\nmore text\n")).toBe("");
  });

  it("picks the fence that holds the diff, not the first one", () => {
    const raw = [
      "```typescript",
      "function helper() { return 1; }",
      "```",
      "Here is the change:",
      "```diff",
      HEADERLESS_FORM,
      "```",
    ].join("\n");
    const out = extractDiff(raw);
    expect(out).toContain("+++ b/src/Forge.sol");
    expect(out).not.toContain("helper()");
  });

  it("drops prose after the diff", () => {
    const out = extractDiff(HEADERLESS_FORM + "\n\nLet me know if you want the tests updated too.");
    expect(out).toContain("total += 1;");
    expect(out).not.toContain("Let me know");
  });

  it("keeps blank lines inside a hunk", () => {
    // git tolerates a context line whose trailing whitespace was stripped. Dropping it
    // changes the hunk's line count and the patch stops applying.
    const withBlank = [
      "diff --git a/src/x.sol b/src/x.sol",
      "--- a/src/x.sol",
      "+++ b/src/x.sol",
      "@@ -1,3 +1,4 @@",
      " line one",
      "",
      "+inserted",
      " line three",
    ].join("\n");
    const out = extractDiff(withBlank);
    expect(out.split("\n")).toContain("");
    expect(out).toContain("+inserted");
  });

  it("returns empty when there is no diff at all", () => {
    expect(extractDiff("I could not figure this out.")).toBe("");
    expect(extractDiff("")).toBe("");
  });
});

describe("filesTouched", () => {
  it("reads the git header form", () => {
    expect(filesTouched(GIT_FORM)).toEqual(["src/Forge.sol"]);
  });

  it("reads the headerless form", () => {
    expect(filesTouched(HEADERLESS_FORM)).toEqual(["src/Forge.sol"]);
  });

  it("collects every file in a multi-file patch", () => {
    const multi = [
      "diff --git a/src/a.sol b/src/a.sol",
      "--- a/src/a.sol",
      "+++ b/src/a.sol",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "diff --git a/src/b.sol b/src/b.sol",
      "--- a/src/b.sol",
      "+++ b/src/b.sol",
      "@@ -1 +1 @@",
      "-x",
      "+y",
    ].join("\n");
    expect(filesTouched(multi)).toEqual(["src/a.sol", "src/b.sol"]);
  });

  it("de-duplicates a file touched twice", () => {
    const twice = [
      "diff --git a/src/a.sol b/src/a.sol",
      "--- a/src/a.sol",
      "+++ b/src/a.sol",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "diff --git a/src/a.sol b/src/a.sol",
      "--- a/src/a.sol",
      "+++ b/src/a.sol",
      "@@ -5 +5 @@",
      "-p",
      "+q",
    ].join("\n");
    expect(filesTouched(twice)).toEqual(["src/a.sol"]);
  });
});

describe("touchesTests fails closed", () => {
  it("flags a headerless diff aimed at the pinned suite", () => {
    // The exact hole the live run exposed: no git header, so the old parser saw no
    // files and answered "clean".
    const attack = [
      "--- a/test/Forge.t.sol",
      "+++ b/test/Forge.t.sol",
      "@@ -1,2 +1,2 @@",
      "-assert(f.total() == 1);",
      "+// relaxed",
    ].join("\n");
    expect(extractDiff(attack)).toContain("Forge.t.sol");
    expect(touchesTests(attack)).toBe(true);
  });

  it("flags a headerless diff against a .t.sol anywhere in the path", () => {
    const attack = [
      "--- a/contracts/test/helpers/Token.t.sol",
      "+++ b/contracts/test/helpers/Token.t.sol",
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ].join("\n");
    expect(touchesTests(attack)).toBe(true);
  });

  it("flags a .test.ts target", () => {
    expect(
      touchesTests(
        "--- a/src/foo.test.ts\n+++ b/src/foo.test.ts\n@@ -1 +1 @@\n-a\n+b",
      ),
    ).toBe(true);
  });

  it("treats an unidentifiable non-empty patch as a violation", () => {
    // Cannot be shown to be safe, and the burden of proof is the agent's.
    expect(touchesTests("@@ -1 +1 @@\n-a\n+b")).toBe(true);
    expect(touchesTests("random text")).toBe(true);
  });

  it("is not fooled by a normal source patch", () => {
    expect(touchesTests(HEADERLESS_FORM)).toBe(false);
    expect(touchesTests(GIT_FORM)).toBe(false);
  });

  it("says no for an empty patch", () => {
    expect(touchesTests("")).toBe(false);
    expect(touchesTests("   \n  ")).toBe(false);
  });

  it("ignores /dev/null so a created-then-deleted file is not a test hit", () => {
    const created = [
      "diff --git a/test/new.t.sol b/test/new.t.sol",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/test/new.t.sol",
      "@@ -0,0 +1 @@",
      "+contract T {}",
    ].join("\n");
    // a genuinely new test file is still a test hit by path
    expect(touchesTests(created)).toBe(true);
  });
});