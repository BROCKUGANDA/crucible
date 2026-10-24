import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SPAN_ACTORS, SPAN_INVENTORY } from "@crucible/smith/trace";

/**
 * The keeper's spans and the spine's inventory must say the same thing.
 *
 * The showcase renders a trace from SPAN_INVENTORY — actor, meaning, detail keys. A span
 * produced here but absent there is a page that cannot explain what it is showing, and a
 * span renamed here would leave the inventory describing a producer that no longer exists.
 *
 * So this reads the `span:` literals out of `main.ts` — the file that runs, not the prose
 * around it, which is the same lesson as the `includes("--strict")` gate that matched a
 * script's comments and stayed green after the flag was deleted.
 */
const SOURCE = readFileSync(fileURLToPath(new URL("../src/main.ts", import.meta.url)), "utf8");

// Strip comment lines before matching: a span name quoted in a comment is not a span
// written, and inventorying it would be recording the file's prose as if it ran.
const code = SOURCE.split("\n")
  .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .join("\n");

const produced = new Set([...code.matchAll(/\bspan:\s*"([^"]+)"/g)].map((m) => m[1]!));

describe("trace span inventory — the producer side", () => {
  it("the keeper produces spans (the extraction reads real code)", () => {
    expect(produced.size).toBeGreaterThan(0);
  });

  it("every produced span is in the inventory, as a keeper span", () => {
    const unexplained = [...produced].filter((name) => !SPAN_INVENTORY[name]);
    expect(
      unexplained,
      `main.ts emits spans SPAN_INVENTORY cannot explain: ${unexplained.join(", ")}`,
    ).toEqual([]);
    for (const name of produced) {
      expect(SPAN_INVENTORY[name]!.actor, `${name} is written by the keeper`).toBe("keeper");
    }
  });

  it("the inventory's actors include the one this process writes as", () => {
    expect(SPAN_ACTORS).toContain("keeper");
  });
});
