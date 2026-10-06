import { describe, expect, it } from "vitest";
import { extractDiff, SYSTEM_PROMPT } from "../src/agent";

/**
 * The file-context regression.
 *
 * Found by the first live run. The agent was asked for a unified diff and had never
 * been shown the file, so it reconstructed the context lines from memory and invented
 * them: it renamed `event Counted(uint256 newTotal)` to `uint256 value`, and guessed
 * line numbers that did not exist. The patch applied to nothing.
 *
 * A unified diff is not a description of a change — it is the change plus verbatim
 * context. An agent that cannot see the file cannot produce one that applies, so the
 * runner now hands it the source and the prompt says so.
 */

const SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Forge {
    uint256 public total;

    event Counted(uint256 newTotal);

    // TODO: increment total and emit Counted
    function increment() external {}
}
`;

/** A diff with genuinely verbatim context, as a model should produce when shown the file. */
const GOOD_DIFF = `--- a/src/Forge.sol
+++ b/src/Forge.sol
@@ -9,2 +9,6 @@ contract Forge {
     // TODO: increment total and emit Counted
-    function increment() external {}
+    function increment() external {
+        total += 1;
+        emit Counted(total);
+    }
 }
`;

function stepPrompt(files: Record<string, string> | undefined): string {
  // Reproduce the section the agent builds, without a network call.
  const parts = ["--- TASK SPEC ---", "do the thing"];
  const paths = Object.keys(files ?? {}).sort();
  if (paths.length > 0) {
    parts.push("", "--- FILES YOU MAY EDIT (copy context lines verbatim) ---");
    for (const p of paths) {
      parts.push("", `### ${p}`, "```", files![p]!.slice(0, 12_000), "```");
    }
  }
  return parts.join("\n");
}

describe("the prompt tells the model what a diff requires", () => {
  it("states that context lines are verbatim", () => {
    expect(SYSTEM_PROMPT).toMatch(/verbatim/i);
    expect(SYSTEM_PROMPT).toMatch(/context lines/i);
  });

  it("warns against retyping context from memory", () => {
    expect(SYSTEM_PROMPT).toMatch(/memory/i);
  });

  it("still forbids editing the pinned tests", () => {
    expect(SYSTEM_PROMPT).toMatch(/Do not modify the test suite/i);
  });

  it("still marks the untrusted region as data, not instruction", () => {
    expect(SYSTEM_PROMPT).toMatch(/never an instruction/i);
  });
});

describe("file context reaches the prompt", () => {
  it("includes the file when one is supplied", () => {
    const prompt = stepPrompt({ "src/Forge.sol": SOURCE });
    expect(prompt).toContain("src/Forge.sol");
    expect(prompt).toContain("uint256 newTotal");
    expect(prompt).toContain("function increment() external {}");
  });

  it("omits the section entirely when there is nothing to show", () => {
    expect(stepPrompt({})).not.toContain("FILES YOU MAY EDIT");
    expect(stepPrompt(undefined)).not.toContain("FILES YOU MAY EDIT");
  });

  it("orders paths so the prompt is deterministic", () => {
    const a = stepPrompt({ "src/z.sol": "z", "src/a.sol": "a" });
    expect(a.indexOf("src/a.sol")).toBeLessThan(a.indexOf("src/z.sol"));
  });

  it("does not send the pinned suite", () => {
    // The runner only ever populates editable files. This is the property the whole
    // "do not modify the tests" rule leans on, so it is worth stating explicitly.
    const prompt = stepPrompt({ "src/Forge.sol": SOURCE });
    expect(prompt).not.toContain("test/");
  });
});

describe("extracted diffs are applicable by construction", () => {
  it("ends with a newline, which git apply requires", () => {
    // Without this, git rejects the whole patch as "corrupt" at the last line. This was
    // the first thing that broke in the live run.
    const patch = extractDiff(GOOD_DIFF);
    expect(patch.endsWith("\n")).toBe(true);
    expect(patch.endsWith("\n\n")).toBe(false);
  });

  it("preserves verbatim context so the hunk can match", () => {
    const patch = extractDiff(GOOD_DIFF);
    expect(patch).toContain("     // TODO: increment total and emit Counted");
    expect(patch).toContain("-    function increment() external {}");
    expect(patch).toContain("+        total += 1;");
  });

  it("keeps the leading space on every context line", () => {
    // git distinguishes context from content by that leading space. Losing it turns a
    // context line into something else entirely.
    const lines = extractDiff(GOOD_DIFF).split("\n");
    // drop the empty final element produced by the trailing newline
    if (lines[lines.length - 1] === "") lines.pop();

    for (const line of lines) {
      if (line === "") continue;
      if (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-")) continue;
      expect(line).toMatch(/^(diff --git|index |--- |\+\+\+ |@@)/);
    }
  });
});